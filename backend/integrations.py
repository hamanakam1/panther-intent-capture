"""Portable intent exports and an explicit, retry-safe local dashboard adapter.

Submission is called after either exact-ticket confirmation or an explicitly
admitted per-capture delivery policy. Neither grants execution authority. This module does not import
dashboard internals, inspect its database, or follow HTTP redirects.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

try:
    from . import storage
except ImportError:  # python backend/server.py
    import storage

SCHEMA_VERSION = "1.2"
FENCE = "not authorized for autonomous execution"
SOURCE = "panther-intent-capture:agent-proposal"
REQUEST_TIMEOUT = 8
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
BEFORE_POST = None  # Installed only by the browser-owned runtime; never an HTTP control.
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_SECRET = re.compile(r"token|secret|password|credential|auth|api.?key|session|cookie", re.I)


def _text(value: Any, limit: int = 12000) -> str:
    return str(value or "").strip()[:limit]


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError(f"A stable {label} is required")
    return value


def _safe_url(value: Any) -> str:
    """Retain source location, omitting credentials and sensitive query values."""
    try:
        url = urllib.parse.urlsplit(_text(value, 4000))
        if url.scheme not in {"http", "https"} or not url.hostname:
            return ""
        host = url.hostname
        host = f"[{host}]" if ":" in host else host
        if url.port:
            host += f":{url.port}"
        query = urllib.parse.urlencode([
            (key, "[redacted]" if _SECRET.search(key) else val)
            for key, val in urllib.parse.parse_qsl(url.query, keep_blank_values=True)
        ])
        fragment = "[redacted]" if _SECRET.search(url.fragment) else url.fragment
        return urllib.parse.urlunsplit((url.scheme, host, url.path, query, fragment))[:1200]
    except (TypeError, ValueError):
        return ""


def _strings(value: Any, limit: int = 20) -> list[str]:
    if isinstance(value, str):
        value = value.splitlines()
    if not isinstance(value, list):
        return []
    return [_text(v, 1200) for v in value[:limit] if isinstance(v, str) and v.strip()]


def _references(value: Any) -> list:
    """Copy bounded evidence identifiers, never images, raw events or disk paths."""
    if not isinstance(value, list):
        return []
    result = []
    for ref in value[:30]:
        if isinstance(ref, str) and len(ref) <= 200 and not ref.startswith(("/", "~", "file:", "data:")):
            result.append(ref)
        elif isinstance(ref, dict):
            clean = {key: val for key, val in ref.items()
                     if key in {"id", "kind", "type", "event_index", "frame_index", "timestamp", "timestamp_ms", "timestamp_seconds"}
                     and isinstance(val, (str, int, float)) and len(str(val)) <= 200}
            if clean:
                result.append(clean)
    return result


def _friction(value: Any) -> list:
    """Copy bounded friction hypotheses.

    A friction signal is a possibility about the recorded actions, never a
    confirmed defect. Only the allowlisted fields travel.
    """
    if not isinstance(value, list):
        return []
    result = []
    for item in value[:10]:
        if not isinstance(item, dict):
            continue
        clean: dict[str, Any] = {}
        kind = item.get("kind")
        if isinstance(kind, str) and kind:
            clean["kind"] = kind[:60]
        title = item.get("title")
        if isinstance(title, str) and title:
            clean["title"] = title[:200]
        detail = item.get("detail")
        if isinstance(detail, str) and detail:
            clean["detail"] = detail[:600]
        indices = item.get("event_indices")
        if isinstance(indices, list):
            clean["event_indices"] = [entry for entry in indices[:50]
                                      if isinstance(entry, int) and not isinstance(entry, bool) and entry >= 1]
        if item.get("hypothesis") is True:
            clean["hypothesis"] = True
        if clean:
            result.append(clean)
    return result


def _diagnostics(value: Any) -> list:
    """Copy bounded page-failure records.

    A failure is what the page's own error stream said. Only the allowlisted
    fields travel: a kind, the recorded event index, a bounded message, a
    sanitized location and, for HTTP failures, a status code. No stack trace,
    page text or image content is included.
    """
    if not isinstance(value, list):
        return []
    result = []
    for item in value[:20]:
        if not isinstance(item, dict):
            continue
        clean: dict[str, Any] = {}
        kind = item.get("kind")
        if isinstance(kind, str) and kind:
            clean["kind"] = kind[:40]
        index = item.get("event_index")
        if isinstance(index, int) and not isinstance(index, bool) and index >= 1:
            clean["event_index"] = index
        message = item.get("message")
        if isinstance(message, str) and message.strip():
            clean["message"] = message[:300]
        source = item.get("source")
        if isinstance(source, str) and source:
            clean["source"] = _safe_url(source)
        status = item.get("status")
        if isinstance(status, int) and not isinstance(status, bool) and 400 <= status <= 599:
            clean["status"] = status
        if clean.get("kind") == "uncaught_exception":
            for key in ("line", "column"):
                position = item.get(key)
                if isinstance(position, int) and not isinstance(position, bool) and 0 <= position <= 1000000:
                    clean[key] = position
        if clean:
            result.append(clean)
    return result


def _draft(ticket: dict) -> dict:
    if not isinstance(ticket, dict):
        raise ValueError("Ticket must be an object")
    title = _text(ticket.get("title"), 1000)
    if not title:
        raise ValueError("Ticket title is required")
    provenance = ticket.get("provenance") or {}
    if not isinstance(provenance, dict):
        provenance = {}
    clean_provenance = {key: (_text(provenance[key], 300) if isinstance(provenance[key], str) else provenance[key])
                       for key in ("generation_revision", "evidence_kind", "proposal_verified",
                                   "origin", "producer", "recording_id", "mode", "model", "generator", "inference_kind",
                                   "evidence_mode", "created_at", "confidence", "warning", "event_count", "events_total",
                                   "events_truncated", "screenshots_count", "media_analyzed", "diagnostic_count")
                       if key in provenance and (provenance[key] is None or isinstance(provenance[key], (str, int, float, bool)))}
    screenshots = ticket.get("screenshots")
    if not isinstance(screenshots, list):
        screenshots = []
    return {
        "id": _identifier(ticket.get("id"), "ticket id"),
        "title": title,
        "description": _text(ticket.get("description")),
        "hypothesis": _text(ticket.get("hypothesis"), 2000),
        "steps_to_reproduce": _strings(ticket.get("steps_to_reproduce")),
        "suggested_verification_steps": _strings(ticket.get("suggested_verification_steps")),
        "acceptance_criteria": _strings(ticket.get("acceptance_criteria")),
        "desired_behavior": _text(ticket.get("desired_behavior"), 2000),
        "questions": _strings(ticket.get("questions"), 5),
        "component": _text(ticket.get("component"), 200),
        "priority": _text(ticket.get("priority") or "medium", 20),
        "evidence": _text(ticket.get("evidence"), 6000),
        "evidence_refs": _references(ticket.get("evidence_refs")),
        "diagnostics": _diagnostics(ticket.get("diagnostics")),
        "friction": _friction(ticket.get("friction")),
        "screenshot_timestamps": [v for v in screenshots[:20]
                                 if isinstance(v, (int, float)) and not isinstance(v, bool)],
        "source_url": _safe_url(ticket.get("source_url") or provenance.get("source_url") or provenance.get("url")),
        "provenance": {"origin": "observed_evidence" if provenance.get("mode") == "observed" else "unverified_proposal", **clean_provenance},
        "status": "draft",
        "requires_review": True,
        "execution_authorized": False,
    }


def _recording(recording: dict) -> dict:
    if not isinstance(recording, dict):
        raise ValueError("Recording must be an object")
    return {
        "id": _identifier(recording.get("id"), "recording id"),
        "source_url": _safe_url(recording.get("source_url") or recording.get("page_url") or recording.get("url")),
        "title": _text(recording.get("title"), 300),
        "stated_goal": _text(recording.get("goal"), 2000),
        "capture_mode": _text(recording.get("capture_mode"), 30),
        **{key: recording[key] for key in ("start_time", "end_time", "duration_ms", "event_count", "screenshot_count")
           if key in recording and isinstance(recording[key], (int, float))},
        **({"diagnostic_count": recording["diagnostic_count"]}
           if isinstance(recording.get("diagnostic_count"), int) and not isinstance(recording.get("diagnostic_count"), bool)
           else {}),
    }


def export_bundle(recording: dict, data: dict) -> dict:
    """Return destination-independent JSON without performing any delivery."""
    if not isinstance(data, dict):
        raise ValueError("Draft bundle must be an object")
    data = data.get("data", data)
    if not isinstance(data, dict) or not isinstance(data.get("tickets"), list):
        raise ValueError("Draft bundle must contain tickets")
    return {
        "schema": "https://github.com/hamanakam1/panther-intent-capture#intent-bundle",
        "schema_version": SCHEMA_VERSION,
        "producer": "panther-intent-capture",
        "exported_at": time.time(),
        "recording": _recording(recording),
        "tickets": [_draft(ticket) for ticket in data["tickets"]],
        "authority": {"export_only": True, "requires_review": True, "execution_authorized": False},
    }


def _target() -> str:
    raw = os.environ.get("PANTHER_DASHBOARD_URL", "")
    if not raw:
        raise ValueError("Configure PANTHER_DASHBOARD_URL before using ticket delivery")
    try:
        url = urllib.parse.urlsplit(raw)
        host = url.hostname
        if (url.scheme not in {"http", "https"} or not host or url.username is not None or url.password is not None
                or url.path not in {"", "/"} or url.query or url.fragment):
            raise ValueError
        # Resolve no arbitrary DNS names. Canonicalize localhost before I/O so
        # hosts-file/proxy configuration cannot redirect a local destination.
        if host.lower() == "localhost":
            host = "127.0.0.1"
        if "%" in host or not ipaddress.ip_address(host).is_loopback:
            raise ValueError
        port = url.port or (443 if url.scheme == "https" else 80)
        host = f"[{host}]" if ":" in host else host
        return f"{url.scheme}://{host}:{port}"
    except (TypeError, ValueError):
        raise ValueError("PANTHER_DASHBOARD_URL must be a loopback HTTP(S) origin without credentials, path, query or fragment") from None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        raise ValueError("Dashboard redirects are prohibited; configure its direct loopback URL")


def _request(target: str, path: str, payload: dict | None = None, *, before_send=None) -> dict:
    req = urllib.request.Request(
        target + path,
        data=json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8") if payload is not None else None,
        headers={"Accept": "application/json", **({"Content-Type": "application/json"} if payload is not None else {})},
        method="POST" if payload is not None else "GET",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    if payload is not None:
        if BEFORE_POST is not None:
            BEFORE_POST()
        if before_send is not None:
            before_send()
    try:
        response = opener.open(req, timeout=REQUEST_TIMEOUT)
    except urllib.error.HTTPError as exc:
        exc.close()
        raise
    with response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("Dashboard response exceeded the bounded read limit")
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("Dashboard returned a non-object JSON response")
        return parsed


def dashboard_status() -> dict:
    """Check reachability only; no private ticket data or writes."""
    try:
        target = _target()
    except ValueError as exc:
        return {"ok": False, "state": "unconfigured", "url": "", "error": _error(exc)}
    try:
        data = _request(target, "/healthz")
        ok = data.get("ok") is True
        return {"ok": ok, "state": "reachable" if ok else "unavailable", "url": target,
                "detail": "Health route reachable; ticket delivery has not been verified." if ok else "Dashboard health did not report ok."}
    except (OSError, ValueError, urllib.error.URLError) as exc:
        return {"ok": False, "state": "unavailable", "url": target, "error": _error(exc)}


def _error(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"Dashboard returned HTTP {exc.code}; no delivery is confirmed."
    if isinstance(exc, (TimeoutError, urllib.error.URLError, OSError)):
        return "Dashboard could not be reached or timed out; any retry uses the same capture identity."
    return _text(str(exc), 250) or "Dashboard response could not be verified."


def _receipt_path(target: str, seed: str):
    name = hashlib.sha256(f"{target}\n{seed}".encode()).hexdigest()
    return storage.ROOT / "deliveries" / f"{name}.json"


def _load_receipt(target: str, seed: str) -> dict | None:
    path = _receipt_path(target, seed)
    if not path.exists():
        return None
    try:
        receipt = json.loads(path.read_text())
        if not isinstance(receipt, dict) or receipt.get("target") != target or receipt.get("seed_key") != seed:
            raise ValueError
        return receipt
    except (OSError, ValueError):
        raise ValueError("Existing delivery receipt is unreadable; resolve it before submitting again") from None


def preview_ticket(recording: dict, ticket: dict) -> dict:
    """Build the exact bounded payload; this function never contacts dashboard."""
    record, draft, target = _recording(recording), _draft(ticket), _target()
    seed = f"panther:capture:{record['id']}:{draft['id']}"
    source_url = draft["source_url"] or record["source_url"] or "not captured"
    # Put the evidence qualifications first so verbose model/provider metadata
    # cannot push them outside the bounded dashboard provenance summary.
    provenance = draft["provenance"]
    provenance_summary = {
        "generation_revision": provenance.get("generation_revision", "unknown"),
        "evidence_kind": _text(provenance.get("evidence_kind") or "unknown", 40),
        "proposal_verified": provenance.get("proposal_verified") is True,
        "mode": _text(provenance.get("mode") or "unknown", 20),
        "model": _text(provenance.get("model"), 80) or None,
    }
    header = (
        f"{FENCE}.\nReview-only Panther agent proposal.\n"
        f"Capture: {record['id']} | Draft: {draft['id']}\n"
        f"Source: {source_url[:400]}\n"
        f"Recorded: {record.get('start_time', 'unknown')} to {record.get('end_time', 'unknown')} (capture timestamps)\n"
        f"Provenance: {json.dumps(provenance_summary, ensure_ascii=False)[:300]}\n"
    )
    # Reserve room for every category, rather than dropping evidence when a
    # long model description consumes the dashboard's 4000-character field.
    sections = [header,
        "Intent / proposed change:\n" + draft["description"][:750],
        "Observed evidence:\n" + draft["evidence"][:450],
        "Steps to reproduce:\n" + "\n".join(draft["steps_to_reproduce"])[:450],
        "Expected result / acceptance criteria:\n" + "\n".join(draft["acceptance_criteria"])[:450],
        "Evidence references:\n" + json.dumps({"refs": draft["evidence_refs"], "frame_seconds": draft["screenshot_timestamps"]}, ensure_ascii=False)[:300],
    ]
    detail = "\n\n".join(sections)
    warnings = ["Created tickets remain in backlog with no-auto; delivery does not authorize execution.",
                "A bounded summary is sent; the full neutral export remains available in Panther."]
    if len(detail) > 3950:
        detail = detail[:3950] + "\n[Summary shortened; consult Panther export.]"
    if len(draft["title"]) > 200:
        warnings.append("The dashboard title is shortened to 200 characters.")
    payload = {
        "seed_key": seed, "source": SOURCE, "title": draft["title"][:200], "detail": detail,
        "system": "ticket-service", "category": "planning", "status": "backlog",
        "priority": {"high": 1, "medium": 2, "low": 3}.get(draft["priority"].lower(), 2),
        "effort": "M", "tags": ["panther", "needs-triage", "no-auto"], "project": "Panther Intent Capture",
    }
    # Confirmation covers destination AND the actual bounded outbound payload.
    # Keep the complete draft too: edits beyond its summary budget still change
    # what was reviewed. Configuration or adapter changes require a new preview.
    fingerprint = hashlib.sha256(json.dumps({"target_url": target, "payload": payload,
                                             "recording": record, "draft": draft},
                                            sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    with storage.DATA_LOCK:
        receipt = _load_receipt(target, seed)
    return {"ok": True, "target": "ticket-service", "target_url": target, "payload": payload,
            "seed_key": seed, "payload_hash": fingerprint, "warnings": warnings, "receipt": receipt}


def _result(receipt: dict, error: str = "", *, previously_verified: bool = False) -> dict:
    result = {"ok": receipt.get("state") == "delivered", "state": receipt["state"],
              "verified": receipt.get("verified") is True, "previously_verified": previously_verified,
              "verified_at": receipt.get("verified_at"), "receipt": receipt}
    if receipt.get("item"):
        key = f"M-{receipt['item']}"
        result.update(ticket_key=key, ticket_url=f"{receipt['target']}/?ticket={key}&view=full", created=receipt.get("created"))
    if error or receipt.get("error"):
        result["error"] = error or receipt["error"]
    return result


def _verify(target: str, item: int, payload: dict) -> None:
    data = _request(target, f"/api/tix/ticket?key=M-{item}&seen=0")
    # The actual Ticket Center response is a flat object, not {ticket:{...}}.
    tags = data.get("tags", [])
    if isinstance(tags, str):
        tags = [tag.strip() for tag in tags.split(",")]
    if (data.get("key") != f"M-{item}" or data.get("id") != item
            or data.get("seed_key") != payload["seed_key"] or data.get("source") != SOURCE):
        raise ValueError("Dashboard readback did not confirm the exact capture identity; delivery remains pending.")
    if (data.get("title") != payload["title"] or data.get("detail") != payload["detail"]
            or data.get("native_status") != "backlog" or "no-auto" not in tags or "auto" in tags
            or "needs-triage" not in tags):
        raise ValueError("Dashboard ticket content or review fences differ; it was not updated. Review the existing ticket.")


def submit_ticket(recording: dict, ticket: dict, *, before_send=None) -> dict:
    """Submit ONE explicitly admitted draft, preserving uncertain delivery state.

    The HTTP route owns manual confirmation; the automation worker owns its
    separately consented, bounded capture policy and frozen proposal checks.
    We serialize receipt and request handling
    with storage's lock; atomic receipts precede writes so interruption retains
    the original identity. Retrying an unknown result reuses that same seed.
    """
    preview = preview_ticket(recording, ticket)
    target, payload = preview["target_url"], preview["payload"]
    with storage.DATA_LOCK:
        prior = _load_receipt(target, preview["seed_key"])
        if prior and prior.get("payload_hash") != preview["payload_hash"]:
            return {"ok": False, "state": "conflict", "verified": False, "receipt": prior,
                    "error": "This draft was already submitted with different content. Existing dashboard tickets are never silently updated; review that ticket or create a distinct draft."}
        if prior and prior.get("state") == "delivered":
            return _result(prior, previously_verified=True)
        receipt = dict(prior or {}, target=target, seed_key=preview["seed_key"], payload_hash=preview["payload_hash"],
                       state="pending", verified=False, updated_at=time.time())
        receipt.pop("error", None)
        path = _receipt_path(target, preview["seed_key"])
        storage.write_json(path, receipt)  # failure here must prevent any POST
        try:
            if not receipt.get("item"):
                response = _request(target, "/api/master/add", payload, before_send=before_send)
                item = response.get("item")
                if response.get("ok") is not True or type(item) is not int or item <= 0:
                    receipt.update(state="refused", error="Dashboard did not return a valid ticket ID; intake may be paused or capped.")
                    if response.get("error"):
                        receipt["error"] += " " + _text(response["error"], 180)
                    storage.write_json(path, receipt)
                    return _result(receipt)
                if type(response.get("created")) is not bool:
                    raise ValueError("Dashboard omitted its creation result; retry will reuse the same capture identity.")
                receipt.update(item=item, created=response["created"], updated_at=time.time())
                storage.write_json(path, receipt)
            _verify(target, receipt["item"], payload)
            receipt.update(state="delivered", verified=True, verified_at=time.time(), updated_at=time.time())
        except (OSError, ValueError, urllib.error.URLError) as exc:
            receipt.update(state="pending", verified=False, error=_error(exc), updated_at=time.time())
        storage.write_json(path, receipt)
        return _result(receipt)
