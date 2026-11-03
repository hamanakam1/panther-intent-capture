"""An explicit GitHub Issues destination.

This is Panther's first remote destination, and it is deliberately narrow. The
host is fixed, the repository is named explicitly, the credential is read only
here, and the destination is never reachable unless it has been configured.

It is not a general webhook client. The dashboard adapter stays loopback-only
and its host checks are not relaxed to make this one work.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

try:
    from . import storage
except ImportError:  # python backend/server.py
    import storage

import integrations

API_HOST = "https://api.github.com"
TOKEN_ENV = "PANTHER_GITHUB_TOKEN"
REPO_ENV = "PANTHER_GITHUB_REPO"
KIND = "github"
FENCE = integrations.FENCE
REQUEST_TIMEOUT = 15
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_ISSUES_SCANNED = 100
_LABEL = "panther"
_REPO = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})\Z")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        raise ValueError("GitHub redirects are not followed; configure the destination directly")


def _read_file(name: str) -> str:
    path = storage.ROOT / "github" / name
    if not path.is_file():
        return ""
    try:
        if path.stat().st_mode & 0o077:
            # A credential readable by anyone else is not used.
            return ""
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _token() -> str:
    value = (os.environ.get(TOKEN_ENV) or "").strip()
    return value or _read_file("token")


def _repo() -> str:
    value = (os.environ.get(REPO_ENV) or "").strip()
    return value or _read_file("repo")


def _valid_repo(value: str) -> bool:
    return bool(value) and bool(_REPO.fullmatch(value))


def _valid_token(value: str) -> bool:
    return len(value) >= 20 and not any(character.isspace() for character in value)


def configuration() -> Dict[str, Any]:
    """What is configured, without ever revealing the credential."""
    repo = _repo()
    token = _token()
    return {
        "configured": _valid_repo(repo) and _valid_token(token),
        "repo": repo if _valid_repo(repo) else "",
        "host": API_HOST,
        "credential": "present" if _valid_token(token) else "missing",
    }


def target() -> str:
    """The canonical destination this configuration names."""
    repo = _repo()
    if not _valid_repo(repo):
        raise ValueError("Configure a GitHub repository as owner/name before using this destination")
    return f"{API_HOST}/repos/{repo}"


def _request(path: str, payload: Optional[dict] = None, *, before_send=None) -> dict:
    """One authenticated GitHub request. The token never appears in a result."""
    token = _token()
    if not _valid_token(token):
        raise ValueError("Configure a GitHub credential before using this destination")
    request = urllib.request.Request(
        API_HOST + path,
        data=json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8") if payload is not None else None,
        headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                 "Authorization": f"Bearer {token}",
                 **({"Content-Type": "application/json"} if payload is not None else {})},
        method="POST" if payload is not None else "GET",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    if payload is not None:
        if integrations.BEFORE_POST is not None:
            integrations.BEFORE_POST()
        if before_send is not None:
            before_send()
    try:
        response = opener.open(request, timeout=REQUEST_TIMEOUT)
    except urllib.error.HTTPError as exc:
        status = exc.code
        detail = ""
        try:
            body = exc.read(4096).decode("utf-8", "replace")
            parsed = json.loads(body)
            if isinstance(parsed, dict) and isinstance(parsed.get("message"), str):
                detail = f": {parsed['message'][:120]}"
        except (OSError, ValueError, UnicodeError):
            detail = ""
        exc.close()
        raise ValueError(f"GitHub returned HTTP {status}{detail}") from None
    with response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("GitHub response exceeded the bounded read limit")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise ValueError("GitHub returned a response that could not be read") from None
    if not isinstance(parsed, (dict, list)):
        raise ValueError("GitHub returned an unexpected response")
    return parsed


def status() -> Dict[str, Any]:
    """Reachability and credential check. No issue data is read."""
    config = configuration()
    if not config["configured"]:
        return {"ok": False, "state": "unconfigured", "url": "", "repo": config["repo"],
                "error": "Configure a GitHub repository and credential before using this destination."}
    try:
        repository = _request(f"/repos/{config['repo']}")
    except (OSError, ValueError, urllib.error.URLError) as exc:
        return {"ok": False, "state": "unavailable", "url": target(), "repo": config["repo"],
                "error": _error(exc)}
    if not isinstance(repository, dict) or repository.get("full_name") != config["repo"]:
        return {"ok": False, "state": "unavailable", "url": target(), "repo": config["repo"],
                "error": "GitHub did not confirm the configured repository."}
    return {"ok": True, "state": "reachable", "url": target(), "repo": config["repo"],
            "detail": "The repository is reachable. No issue has been read or created."}


def _result(receipt: dict, previously_verified: bool = False) -> dict:
    """Report a delivery outcome without ever exposing the credential."""
    result = {"ok": receipt.get("state") == "delivered", "state": receipt.get("state", "pending"),
              "verified": receipt.get("verified") is True, "previously_verified": previously_verified,
              "verified_at": receipt.get("verified_at"), "receipt": receipt}
    if receipt.get("item"):
        number = receipt["item"]
        result.update(ticket_key=f"#{number}", ticket_url=f"https://github.com/{_repo()}/issues/{number}",
                      created=receipt.get("created"))
    if receipt.get("error"):
        result["error"] = receipt["error"]
    return result


def _error(exc: Exception) -> str:
    if isinstance(exc, ValueError):
        return f"{str(exc)[:200]}. No issue was created."
    return "GitHub could not be reached or timed out; any retry uses the same capture identity."


def _search_marker(recording_id: str, ticket_id: str) -> str:
    """A stable, searchable identity for one draft of one capture."""
    return f"panther-capture-{recording_id}-{ticket_id}"


def _detail(record: dict, draft: dict, seed: str) -> str:
    """The bounded body of the issue, with the review fence and the identity."""
    header = (
        f"{FENCE}.\nReview-only Panther agent proposal.\n"
        f"Capture: {record.get('id', 'unknown')} | Draft: {draft.get('id', 'unknown')}\n"
        f"Source: {str(record.get('source_url') or 'not captured')[:400]}\n"
        f"Recorded: {record.get('start_time', 'unknown')} to {record.get('end_time', 'unknown')} (capture timestamps)\n"
    )
    sections = [header,
                "Intent / proposed change:\n" + str(draft.get("description", ""))[:750],
                "Observed evidence:\n" + str(draft.get("evidence", ""))[:450],
                "Steps to reproduce:\n" + "\n".join(draft.get("steps_to_reproduce", []))[:450],
                "Expected result / acceptance criteria:\n" + "\n".join(draft.get("acceptance_criteria", []))[:450],
                "Evidence references:\n" + json.dumps({"refs": draft.get("evidence_refs", []),
                                                        "frame_seconds": draft.get("screenshot_timestamps", [])},
                                                       ensure_ascii=False)[:300],
                f"Identity: {seed}",
                ]
    return "\n\n".join(sections)[:3900]


def preview_ticket(recording: dict, ticket: dict) -> Dict[str, Any]:
    """Build the exact issue payload. This function never contacts GitHub."""
    record, draft = integrations._recording(recording), integrations._draft(ticket)
    seed = f"panther:capture:{record['id']}:{draft['id']}"
    identity = _search_marker(record["id"], draft["id"])
    body = _detail(record, draft, identity)
    title = str(draft.get("title") or "")[:256]
    if not title:
        raise ValueError("Ticket title is required")
    payload = {
        "title": title,
        "body": body,
        "labels": [_LABEL, "needs-triage", "no-auto"],
    }
    fingerprint = hashlib.sha256(json.dumps(
        {"target_url": target(), "payload": payload, "recording": record, "draft": draft},
        sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    with storage.DATA_LOCK:
        receipt = integrations._load_receipt(target(), seed)
    warnings = ["Created issues are review-fenced: the body states that execution is not authorized.",
                "The no-auto label is a convenience; the review fence is the text in the body.",
                "A bounded summary is sent; the full neutral export remains available in Panther."]
    return {"ok": True, "target": KIND, "target_url": target(), "payload": payload,
            "seed_key": seed, "payload_hash": fingerprint, "warnings": warnings, "receipt": receipt}


def _find_existing(seed: str) -> Optional[dict]:
    """Find an issue that already carries this identity, if one exists."""
    repo = _repo()
    issues = _request(f"/repos/{repo}/issues?state=all&per_page={MAX_ISSUES_SCANNED}&sort=created&direction=desc")
    if not isinstance(issues, list):
        raise ValueError("GitHub returned an unexpected issue list")
    for issue in issues:
        if not isinstance(issue, dict) or "pull_request" in issue:
            continue
        if seed in (issue.get("body") or ""):
            return issue
    return None


def _verify(seed: str, issue: dict, payload: dict) -> None:
    """Confirm the returned issue is exactly the one that was asked for."""
    if (type(issue.get("number")) is not int or issue["number"] <= 0
            or issue.get("title") != payload["title"]
            or seed not in (issue.get("body") or "")
            or issue.get("state") not in ("open", "closed")):
        raise ValueError("GitHub did not confirm the exact issue identity; delivery remains pending.")


def submit_ticket(recording: dict, ticket: dict, *, before_send=None) -> Dict[str, Any]:
    """Create one confirmed issue and verify it, reusing a durable receipt."""
    preview = preview_ticket(recording, ticket)
    destination, payload, seed = preview["target_url"], preview["payload"], preview["seed_key"]
    identity = _search_marker(recording["id"], ticket["id"])
    with storage.DATA_LOCK:
        prior = integrations._load_receipt(destination, seed)
        if prior and prior.get("payload_hash") != preview["payload_hash"]:
            return {"ok": False, "state": "conflict", "verified": False, "receipt": prior,
                    "error": ("This draft was already submitted to GitHub with different content. "
                              "Existing issues are never silently updated; review that issue or create a distinct draft.")}
        if prior and prior.get("state") == "delivered":
            return _result(prior, previously_verified=True)
        receipt = dict(prior or {}, target=destination, seed_key=seed, payload_hash=preview["payload_hash"],
                       state="pending", verified=False, updated_at=time.time())
        receipt.pop("error", None)
        path = integrations._receipt_path(destination, seed)
        storage.write_json(path, receipt)  # a write failure must prevent the request
    try:
        existing = _find_existing(identity)
        if existing:
            receipt.update(item=existing.get("number"), created=False, updated_at=time.time())
            storage.write_json(path, receipt)
        else:
            response = _request(f"/repos/{_repo()}/issues", payload, before_send=before_send)
            if not isinstance(response, dict) or type(response.get("number")) is not int or response["number"] <= 0:
                raise ValueError("GitHub did not return a valid issue number")
            receipt.update(item=response["number"], created=True, updated_at=time.time())
            storage.write_json(path, receipt)
            existing = response
        readback = _request(f"/repos/{_repo()}/issues/{receipt['item']}")
        if not isinstance(readback, dict):
            raise ValueError("GitHub did not return the created issue")
        _verify(identity, readback, payload)
        receipt.update(state="delivered", verified=True, verified_at=time.time(), updated_at=time.time())
    except (OSError, ValueError, urllib.error.URLError) as exc:
        receipt.update(state="pending", verified=False, error=_error(exc), updated_at=time.time())
    storage.write_json(path, receipt)
    return _result(receipt)
