"""Durable, per-capture opt-in delivery; never authorizes downstream execution.

Only an immutable admission policy from the capture request starts a job. The
single worker freezes proposals before delivery and reuses the manual adapter's
stable identities, preview fingerprints and durable receipts.
"""
from __future__ import annotations

import copy
import json
import logging
import math
import threading
import time
from pathlib import Path

import destinations
import integrations
import storage
import tickets

CONSENT_SECONDS = 24 * 60 * 60
MAX_TICKETS = 5
RETRY_DELAYS = (15, 60, 300)
MAX_ATTEMPTS = 1 + len(RETRY_DELAYS)
ACTIVE = {"queued", "generating", "delivering", "retry_wait"}
TERMINAL = {"delivered", "blocked", "cancelled"}
_WAKE = threading.Event()
_STOP = threading.Event()
_PAUSED = threading.Event()
_BROWSER_OWNED = False
_BROWSER_SESSION = None
_WORKER_GUARD = threading.Lock()
_RUN_LOCK = threading.Lock()
_CANCELLED = set()
_WORKER = None
_LOG = logging.getLogger(__name__)


class _StopJob(Exception):
    pass


def admit_policy(value, capture_start: float):
    """Validate separate delivery consent, binding it to this capture's start."""
    if value is None or value == {"enabled": False}:
        return None
    if _PAUSED.is_set():
        raise ValueError("Panther is turning off; new automatic delivery is not admitted")
    allowed = {"enabled", "consent", "target_url", "target_kind", "use_ai", "max_tickets"}
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValueError("Invalid automation policy")
    if value.get("enabled") is not True or value.get("consent") is not True:
        raise ValueError("Separate explicit automatic-delivery consent is required")
    if type(value.get("use_ai")) is not bool:
        raise ValueError("Automation use_ai must be a boolean")
    cap = value.get("max_tickets", MAX_TICKETS)
    if type(cap) is not int or not 1 <= cap <= MAX_TICKETS:
        raise ValueError("Automatic delivery allows at most five drafts per capture")
    kind = value.get("target_kind") or destinations.TICKET_SERVICE
    if not destinations.known(kind):
        raise ValueError("Automatic-delivery destination is unknown")
    target = destinations.target(kind)
    if value.get("target_url") != target:
        raise ValueError("Automatic-delivery destination changed; confirm the configured destination before capturing")
    now = time.time()
    if (not math.isfinite(capture_start) or capture_start <= 0
            or capture_start > now + 300 or capture_start + CONSENT_SECONDS <= now):
        raise ValueError("Automatic-delivery consent must be from a capture started within the last 24 hours")
    policy = {"enabled": True, "consent": True, "policy_version": 2, "target_kind": kind, "target_url": target,
              "use_ai": value["use_ai"], "max_tickets": cap, "consented_at": capture_start,
              "admitted_at": now, "expires_at": capture_start + CONSENT_SECONDS}
    if _BROWSER_OWNED:
        policy["browser_session"] = _BROWSER_SESSION
    return policy


def require_browser_active():
    if _BROWSER_OWNED and _PAUSED.is_set():
        raise ValueError("Panther is off; new requests and outgoing ticket writes are not admitted")


def _validate_policy(policy):
    if (not isinstance(policy, dict) or policy.get("enabled") is not True
            or policy.get("consent") is not True or policy.get("policy_version") not in (1, 2)
            or type(policy.get("use_ai")) is not bool
            or type(policy.get("max_tickets")) is not int or not 1 <= policy["max_tickets"] <= MAX_TICKETS):
        raise ValueError("Automatic-delivery policy is missing or invalid")
    for key in ("consented_at", "admitted_at", "expires_at"):
        if (type(policy.get(key)) not in (int, float) or not math.isfinite(policy[key]) or policy[key] <= 0):
            raise ValueError("Automatic-delivery consent timestamps are invalid")
    if policy["expires_at"] != policy["consented_at"] + CONSENT_SECONDS:
        raise ValueError("Automatic-delivery consent expiry was changed")
    if not isinstance(policy.get("target_url"), str):
        raise ValueError("Automatic-delivery target is missing")
    # Version 1 policies predate more than one destination and named the
    # local ticket service implicitly.
    kind = policy.get("target_kind") or destinations.TICKET_SERVICE
    if not destinations.known(kind):
        raise ValueError("Automatic-delivery destination is unknown")


def _path(recording_id):
    return storage.ROOT / "automation" / f"{storage._safe_id(recording_id)}.json"


def _cancellation_path(recording_id):
    return storage.ROOT / "automation-cancelled" / f"{storage._safe_id(recording_id)}.json"


def _cancelled(recording_id):
    path = _cancellation_path(recording_id)
    if not path.is_file():
        return recording_id in _CANCELLED
    marker = json.loads(path.read_text())
    if (not isinstance(marker, dict) or marker.get("recording_id") != recording_id
            or type(marker.get("expires_at")) not in (int, float)
            or not math.isfinite(marker["expires_at"])):
        raise ValueError("Cancellation receipt is invalid; capture admission is blocked")
    if marker["expires_at"] > time.time():
        return True
    path.unlink()
    _CANCELLED.discard(recording_id)
    return False


def _persist_cancel(recording_id):
    path = _cancellation_path(recording_id)
    if not path.exists():
        # Maximum original consent age plus the allowed client clock skew.
        storage.write_json(path, {"recording_id": recording_id, "cancelled_at": time.time(),
                                  "expires_at": time.time() + CONSENT_SECONDS + 300})


def _remember_cancelled_delivery(recording_id, job):
    marker = json.loads(_cancellation_path(recording_id).read_text())
    # Preserve content-free delivery truth if capture deletion removes the job.
    marker["delivery"] = {key: copy.deepcopy(job[key]) for key in (
        "ticket_count", "delivered_count", "deliveries", "attempts")}
    marker["delivery"].update({key: job["policy"][key] for key in (
        "target_url", "use_ai", "max_tickets", "expires_at")})
    storage.write_json(_cancellation_path(recording_id), marker)


def require_not_cancelled(recording_id):
    """Call under DATA_LOCK before accepting even a delayed original upload."""
    if _cancelled(recording_id):
        raise ValueError("This capture was cancelled; start a new capture instead of replaying it")


def _cancelled_upload(recording_id):
    result = {"ok": True, "recording_id": recording_id, "status": "cancelled", "stage": "capture",
            "upload_cancelled": True, "ticket_count": 0, "delivered_count": 0, "attempts": 0,
            "next_retry_at": None, "error": "Capture admission was cancelled; no saved capture is present",
            "deliveries": [], "target_url": None, "use_ai": False, "execution_authorized": False}
    path = _cancellation_path(recording_id)
    if path.is_file():
        delivery = json.loads(path.read_text()).get("delivery")
        if delivery:
            result.update(copy.deepcopy(delivery))
            result["upload_cancelled"] = False
            result["error"] = "Capture was removed; already sent or uncertain deliveries are not undone"
    return result


def _load(recording_id):
    path = _path(recording_id)
    if not path.is_file():
        return None
    job = json.loads(path.read_text())
    if (not isinstance(job, dict) or job.get("recording_id") != recording_id
            or job.get("status") not in ACTIVE | TERMINAL
            or type(job.get("attempts")) is not int or not 0 <= job["attempts"] <= MAX_ATTEMPTS
            or not isinstance(job.get("deliveries"), list)):
        raise ValueError("Saved automation job is invalid; automatic delivery is blocked")
    _validate_policy(job.get("policy"))
    if any(type(job.get(key)) is not int or job[key] < 0 for key in ("ticket_count", "delivered_count")):
        raise ValueError("Saved automation counts are invalid")
    frozen = job.get("frozen")
    if frozen is not None:
        if (not isinstance(frozen, dict) or not isinstance(frozen.get("recording"), dict)
                or frozen["recording"].get("id") != recording_id
                or not isinstance(frozen.get("items"), list)
                or not 1 <= len(frozen["items"]) <= job["policy"]["max_tickets"]
                or job["ticket_count"] != len(frozen["items"])):
            raise ValueError("Saved automatic-delivery snapshot is invalid")
        seen = set()
        for item in frozen["items"]:
            if not isinstance(item, dict) or not isinstance(item.get("ticket"), dict):
                raise ValueError("Saved automatic-delivery draft is invalid")
            tid = storage._safe_id(item["ticket"].get("id"))
            if (tid in seen or item.get("seed_key") != f"panther:capture:{recording_id}:{tid}"
                    or not isinstance(item.get("payload_hash"), str) or len(item["payload_hash"]) != 64):
                raise ValueError("Saved automatic-delivery identity is invalid")
            seen.add(tid)
        delivery_ids = set()
        for result in job["deliveries"]:
            if (not isinstance(result, dict) or result.get("ticket_id") not in seen
                    or result["ticket_id"] in delivery_ids or type(result.get("verified")) is not bool
                    or result.get("state") not in {"pending", "delivered", "refused", "conflict"}):
                raise ValueError("Saved automatic-delivery result is invalid")
            delivery_ids.add(result["ticket_id"])
    elif job["deliveries"]:
        raise ValueError("Automatic delivery results require frozen proposals")
    return job


def _save(job):
    storage.write_json(_path(job["recording_id"]), job)


def _new_job(entry):
    policy = entry.get("automation")
    _validate_policy(policy)
    started = entry.get("automation_started") is True
    return {"recording_id": entry["id"], "policy": copy.deepcopy(policy), "status": "blocked" if started else "queued",
            "stage": "generation", "ticket_count": 0, "delivered_count": 0, "attempts": 0,
            "next_retry_at": None,
            "error": "Saved automation state is missing after processing began; delivery history is unknown. Automatic regeneration is blocked." if started else "",
            "deliveries": [], "frozen": None,
            "created_at": time.time(), "updated_at": time.time()}


def _entries():
    # One manifest read per scan, not one full-library read per capture.
    storage.ensure_dirs()
    manifest = storage._load_manifest()
    storage._enforce_ttl_and_cap(manifest)
    directory = storage.ROOT / "automation-cancelled"
    if directory.is_dir():
        for path in directory.glob("*.json"):
            try:
                _cancelled(path.stem)  # Removes only expired, validated markers.
            except (OSError, ValueError):
                _LOG.error("A cancellation receipt needs local repair; it was preserved")
    return list(manifest.values())


def enqueue(entry):
    """Recover a missed initial queue write; never overwrite an existing job."""
    with storage.DATA_LOCK:
        if not entry.get("automation"):
            return None
        current = storage.get_recording(entry["id"])
        if not current:
            return None
        existing = _load(entry["id"])
        if existing is None:
            existing = _new_job(current)
            _save(existing)
    _WAKE.set()
    return _public(existing)


def recover_jobs(resume_inflight=False):
    """Admitted policies recover a crash before queue creation; blocked jobs stay put."""
    with storage.DATA_LOCK:
        for entry in _entries():
            if not entry.get("automation"):
                continue
            try:
                job = _load(entry["id"])
                if job is None:
                    _save(_new_job(entry))
                elif resume_inflight and job["status"] in {"generating", "delivering"}:
                    job.update(status="queued", next_retry_at=None, updated_at=time.time(),
                               error="Backend restarted; resuming the same admitted job and delivery identities")
                    _save(job)
            except (OSError, ValueError):
                # Do not replace unreadable job state or invent missing receipts.
                _LOG.error("An admitted automation job could not be recovered")


def _set_state(job, status, error=""):
    job.update(status=status, error=error[:500], next_retry_at=None, updated_at=time.time())
    if status == "delivered":
        job["stage"] = "complete"
    _save(job)


def _checkpoint(recording_id):
    """Must run under DATA_LOCK immediately before each job mutation or send."""
    entry = storage.get_recording(recording_id)
    if not entry:
        raise _StopJob()
    job = _load(recording_id)
    if not job or job["status"] in TERMINAL:
        raise _StopJob()
    session = job["policy"].get("browser_session")
    if session is not None and (not _BROWSER_OWNED or session != _BROWSER_SESSION):
        _set_state(job, "cancelled", "The browser-owned session ended; this automatic job will not resume")
        raise _StopJob()
    revoked = storage.ROOT / "browser-revocation.json"
    if revoked.exists():
        marker = json.loads(revoked.read_text())
        cutoff = marker.get("revoked_at") if isinstance(marker, dict) else None
        if type(cutoff) not in (int, float) or not math.isfinite(cutoff) or cutoff <= 0:
            _set_state(job, "blocked", "Browser power revocation could not be validated")
            raise _StopJob()
        if job["policy"]["admitted_at"] <= cutoff:
            _set_state(job, "cancelled", "Panther was turned off; this automatic job will not resume")
            raise _StopJob()
    if _PAUSED.is_set():
        _set_state(job, "cancelled", "Panther was turned off; this automatic job will not resume")
        raise _StopJob()
    if _cancelled(recording_id):
        _set_state(job, "cancelled", "Future automatic work was cancelled; in-flight delivery cannot be undone")
        raise _StopJob()
    if entry.get("automation") != job["policy"]:
        _set_state(job, "blocked", "The immutable admission policy changed")
        raise _StopJob()
    if time.time() >= job["policy"]["expires_at"]:
        _set_state(job, "blocked", "Automatic-delivery consent expired after 24 hours")
        raise _StopJob()
    kind = job["policy"].get("target_kind") or destinations.TICKET_SERVICE
    try:
        configured_target = destinations.target(kind)
    except ValueError:
        configured_target = None
    if configured_target != job["policy"]["target_url"]:
        _set_state(job, "blocked", "Configured destination differs from the consented destination")
        raise _StopJob()
    return entry, job


def _summary(ticket_id, result):
    receipt = result.get("receipt") or {}
    return {"ticket_id": ticket_id, "state": result.get("state", "pending"),
            "verified": result.get("verified") is True,
            "ticket_key": result.get("ticket_key"), "ticket_url": result.get("ticket_url"),
            "verified_at": result.get("verified_at") or receipt.get("verified_at"),
            "previously_verified": result.get("previously_verified") is True,
            "error": str(result.get("error") or "")[:500]}


def _public(job):
    result = {key: copy.deepcopy(job.get(key)) for key in (
        "recording_id", "status", "stage", "ticket_count", "delivered_count", "attempts",
        "next_retry_at", "error", "deliveries", "updated_at")}
    result.update(ok=True, target_url=job["policy"]["target_url"],
                  target_kind=job["policy"].get("target_kind") or destinations.TICKET_SERVICE,
                  use_ai=job["policy"]["use_ai"],
                  max_tickets=job["policy"]["max_tickets"], expires_at=job["policy"]["expires_at"],
                  execution_authorized=False)
    return result


def _refresh_receipts(job):
    """Recover acknowledgment lost after the adapter's durable receipt write."""
    frozen = job.get("frozen")
    if not frozen:
        return
    by_id = {result["ticket_id"]: result for result in job["deliveries"]}
    for item in frozen["items"]:
        receipt = integrations._load_receipt(job["policy"]["target_url"], item["seed_key"])
        if receipt:
            if receipt.get("payload_hash") != item["payload_hash"]:
                result = {"state": "conflict", "verified": False,
                          "error": "Existing delivery receipt belongs to different content"}
            else:
                result = integrations._result(receipt, previously_verified=True)
            by_id[item["ticket"]["id"]] = _summary(item["ticket"]["id"], result)
    job["deliveries"] = list(by_id.values())
    job["delivered_count"] = sum(item["verified"] and item["state"] == "delivered" for item in job["deliveries"])


def status(recording_id):
    with storage.DATA_LOCK:
        entry = storage.get_recording(recording_id)
        if entry is None:
            if _cancelled(recording_id):
                return _cancelled_upload(recording_id)
            raise ValueError("Recording not found")
        if not entry.get("automation"):
            return {"ok": True, "recording_id": recording_id, "status": "disabled", "stage": "manual",
                    "ticket_count": 0, "delivered_count": 0, "attempts": 0, "next_retry_at": None,
                    "error": "", "deliveries": [], "target_url": None, "use_ai": False,
                    "execution_authorized": False}
        job = _load(recording_id)
        if job is None:
            job = _new_job(entry)
            _save(job)
            _WAKE.set()
        _refresh_receipts(job)
        if (job["status"] != "delivered" and job["ticket_count"]
                and job["delivered_count"] == job["ticket_count"]):
            _set_state(job, "delivered")
        elif job["status"] == "delivered" and job["delivered_count"] != job["ticket_count"]:
            _set_state(job, "blocked", "Saved delivery receipts no longer verify the frozen proposals")
        return _public(job)


def is_active(recording_id):
    """Manual mutations must not change the visible drafts of an active job."""
    return status(recording_id)["status"] in ACTIVE


def signal_cancel(recording_id):
    storage._safe_id(recording_id)
    # This flag deliberately precedes DATA_LOCK: the adapter holds that lock
    # during its current request, but a following ticket must observe the flag.
    with _WORKER_GUARD:
        _CANCELLED.add(recording_id)
    _WAKE.set()


def control(recording_id, action):
    if action not in {"retry", "cancel"}:
        raise ValueError("Automation action must be retry or cancel")
    if action == "cancel":
        signal_cancel(recording_id)
    with storage.DATA_LOCK:
        if action == "cancel":
            _persist_cancel(recording_id)
        entry = storage.get_recording(recording_id)
        if not entry:
            if action == "cancel":
                return _cancelled_upload(recording_id)
            raise ValueError("Recording not found")
        if not entry.get("automation"):
            return status(recording_id)
        job = _load(recording_id)
        if job is None:
            job = _new_job(entry)
        _refresh_receipts(job)
        if action == "cancel":
            if job["status"] != "delivered":
                if job["ticket_count"] and job["delivered_count"] == job["ticket_count"]:
                    _set_state(job, "delivered")
                else:
                    _set_state(job, "cancelled", "Future automatic work was cancelled; already sent tickets remain")
            _remember_cancelled_delivery(recording_id, job)
        else:
            if job["status"] != "retry_wait":
                raise ValueError("Only a waiting retry can be advanced; blocked or cancelled jobs need a new capture")
            try:
                _checkpoint(recording_id)
            except _StopJob:
                return _public(_load(recording_id))
            if job["attempts"] >= MAX_ATTEMPTS:
                raise ValueError("Automatic retry budget is exhausted")
            job.update(status="queued", next_retry_at=None, updated_at=time.time())
            _save(job)
        _WAKE.set()
        return _public(job)


def _retry(recording_id, error, retryable=True):
    with storage.DATA_LOCK:
        try:
            _, job = _checkpoint(recording_id)
        except _StopJob:
            return
        if not retryable or job["attempts"] >= MAX_ATTEMPTS:
            _set_state(job, "blocked", error)
        else:
            job.update(status="retry_wait", error=str(error)[:500],
                       next_retry_at=time.time() + RETRY_DELAYS[job["attempts"] - 1], updated_at=time.time())
            _save(job)


def _snapshot(entry):
    return {key: copy.deepcopy(entry[key]) for key in (
        "id", "url", "title", "goal", "capture_mode", "start_time", "end_time",
        "duration_ms", "event_count", "screenshot_count") if key in entry}


def _record_result(recording_id, ticket_id, result):
    with storage.DATA_LOCK:
        if not storage.get_recording(recording_id):
            return False
        job = _load(recording_id)
        if not job:
            return False
        by_id = {item["ticket_id"]: item for item in job["deliveries"]}
        by_id[ticket_id] = _summary(ticket_id, result)
        job["deliveries"] = list(by_id.values())
        job["delivered_count"] = sum(item["verified"] and item["state"] == "delivered" for item in job["deliveries"])
        if job["ticket_count"] and job["delivered_count"] == job["ticket_count"]:
            _set_state(job, "delivered")
            return False
        if _cancelled(recording_id) or job["status"] == "cancelled":
            _set_state(job, "cancelled", "Future automatic work was cancelled; in-flight delivery was recorded")
            return False
        _save(job)
        return True


def _process(recording_id):
    try:
        with storage.DATA_LOCK:
            entry, job = _checkpoint(recording_id)
            _refresh_receipts(job)
            if job["ticket_count"] and job["delivered_count"] == job["ticket_count"]:
                _set_state(job, "delivered")
                return
            if job["attempts"] >= MAX_ATTEMPTS:
                _set_state(job, "blocked", "Automatic retry budget is exhausted")
                return
            storage.mark_automation_started(recording_id)
            job.update(attempts=job["attempts"] + 1, status="delivering" if job.get("frozen") else "generating",
                       stage="delivery" if job.get("frozen") else "generation", error="", next_retry_at=None,
                       updated_at=time.time())
            _save(job)
            frozen = job.get("frozen")
            kind = job["policy"].get("target_kind") or destinations.TICKET_SERVICE
        if not frozen:
            events = json.loads(Path(entry["events_path"]).read_text()) if entry.get("events_path") else []
            generated = tickets.generate_drafts(entry, events, use_ai=job["policy"]["use_ai"])
            with storage.DATA_LOCK:
                entry, job = _checkpoint(recording_id)
                count = len(generated["tickets"])
                job["ticket_count"] = count
                if not 1 <= count <= job["policy"]["max_tickets"]:
                    tickets.save_tickets(recording_id, generated)
                    _set_state(job, "blocked", f"Generated {count} drafts; allowed range is 1 to {job['policy']['max_tickets']}. Nothing was automatically sent.")
                    return
                snapshot = _snapshot(entry)
                items = []
                for ticket in generated["tickets"]:
                    preview = destinations.preview(kind, snapshot, ticket)
                    if preview["target_url"] != job["policy"]["target_url"]:
                        raise ValueError("Configured destination changed before proposal freeze")
                    prior = preview.get("receipt")
                    if prior and prior.get("payload_hash") != preview["payload_hash"]:
                        raise ValueError("An existing delivery has different content; automatic delivery is blocked")
                    items.append({"ticket": copy.deepcopy(ticket), "payload_hash": preview["payload_hash"], "seed_key": preview["seed_key"]})
                frozen = {"recording": snapshot, "items": items}
                job.update(frozen=frozen, status="delivering", stage="delivery", updated_at=time.time())
                _save(job)  # Freeze before any adapter call or editable draft save.
                tickets.save_tickets(recording_id, generated)
        for item in frozen["items"]:
            with storage.DATA_LOCK:
                _, job = _checkpoint(recording_id)
                delivered = {row["ticket_id"] for row in job["deliveries"] if row["state"] == "delivered" and row["verified"]}
                if item["ticket"]["id"] in delivered:
                    continue
                preview = destinations.preview(kind, frozen["recording"], item["ticket"])
                if (preview["target_url"] != job["policy"]["target_url"]
                        or preview["payload_hash"] != item["payload_hash"]):
                    raise ValueError("The frozen destination or proposal payload changed; fresh consent is required")
                result = destinations.submit(kind, frozen["recording"], item["ticket"],
                    before_send=lambda: _checkpoint(recording_id))
            if not _record_result(recording_id, item["ticket"]["id"], result):
                return
            if not result.get("ok") or result.get("verified") is not True:
                _retry(recording_id, result.get("error") or "Delivery remains unverified",
                       retryable=result.get("state") == "pending")
                return
        with storage.DATA_LOCK:
            _, job = _checkpoint(recording_id)
            _set_state(job, "delivered")
    except _StopJob:
        return
    except tickets.DraftGenerationError as exc:
        _retry(recording_id, str(exc))
    except OSError:
        _retry(recording_id, "Local storage or captured evidence is temporarily unavailable")
    except (ValueError, TypeError, KeyError):
        _retry(recording_id, "Automation state or frozen delivery could not be validated", retryable=False)


def _run_once():
    if _PAUSED.is_set():
        return False, 30
    if not _RUN_LOCK.acquire(blocking=False):
        return False, 1
    try:
        now = time.time()
        delay = 30.0
        selected = None
        with storage.DATA_LOCK:
            for entry in _entries():
                if not entry.get("automation"):
                    continue
                try:
                    job = _load(entry["id"])
                    if job is None:
                        job = _new_job(entry)
                        _save(job)
                    # The run lock covers an entire attempt. An in-flight state
                    # seen here is left by an interrupted local persistence step,
                    # not a concurrently running attempt, and retains its budget.
                    if job["status"] in {"queued", "generating", "delivering"}:
                        selected = entry["id"]
                        break
                    if job["status"] == "retry_wait":
                        due = job.get("next_retry_at") or now
                        if due <= now:
                            selected = entry["id"]
                            break
                        delay = min(delay, due - now)
                except (OSError, ValueError):
                    continue
        if selected:
            _process(selected)
            return True, 0
        return False, max(0.1, delay)
    finally:
        _RUN_LOCK.release()


def run_once():
    """One bounded admitted-job attempt, also used by synthetic regression tests."""
    return _run_once()[0]


def _worker_loop():
    try:
        recover_jobs(resume_inflight=True)
    except Exception:
        _LOG.exception("Automatic-delivery recovery needs local storage repair")
    while not _STOP.is_set():
        _WAKE.clear()
        try:
            did_work, delay = _run_once()
        except Exception:
            _LOG.exception("Automatic-delivery worker paused after a local failure")
            did_work, delay = False, 30
        if not did_work:
            _WAKE.wait(delay)


def start_worker():
    global _WORKER
    with _WORKER_GUARD:
        if _WORKER is not None and _WORKER.is_alive():
            return
        _PAUSED.clear()
        _STOP.clear()
        _WORKER = threading.Thread(target=_worker_loop, name="panther-automation", daemon=True)
        _WORKER.start()


def stop_worker(timeout=2):
    _STOP.set()
    _WAKE.set()
    worker = _WORKER
    if worker and worker is not threading.current_thread():
        worker.join(timeout)


def revoke_browser_work():
    """Close admission immediately; persist revocation without waiting on a send.

    The standalone marker has no captured content and does not require the
    adapter's DATA_LOCK. A request already in flight may finish; every next
    checkpoint, including a later CLI launch, observes this durable boundary.
    """
    _PAUSED.set()
    _STOP.set()
    _WAKE.set()
    storage.write_json(storage.ROOT / "browser-revocation.json", {"revoked_at": time.time()})


def cancel_unfinished_browser_work():
    """Before browser On/after Off, cancel prior jobs without generating/sending."""
    _PAUSED.set()
    _STOP.set()
    _WAKE.set()
    with storage.DATA_LOCK:
        for entry in storage._load_manifest().values():
            if not entry.get("automation"):
                continue
            job = _load(entry["id"])
            if job is None:
                job = _new_job(entry)
            if job["status"] not in ACTIVE:
                continue
            signal_cancel(entry["id"])
            _persist_cancel(entry["id"])
            _refresh_receipts(job)
            if job["ticket_count"] and job["delivered_count"] == job["ticket_count"]:
                _set_state(job, "delivered")
            else:
                _set_state(job, "cancelled", "Panther was turned off; this automatic job will not resume")
            _remember_cancelled_delivery(entry["id"], job)
