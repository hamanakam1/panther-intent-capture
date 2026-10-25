"""Loopback API for consented captures, reviewable drafts and explicit delivery."""
from __future__ import annotations

import base64
import json
import math
import mimetypes
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit

import storage
import automation
import destinations
import live_insights
import replay
from redaction import sanitize_events
from tickets import GENERATION_REVISION, capture_diagnostics, generate_drafts, load_tickets, save_tickets, DraftGenerationError
from integrations import SCHEMA_VERSION, export_bundle

UPLOAD_LIMIT = 64 * 1024 * 1024
# The backend's own HTTP API version. It moves independently of the exported
# intent-bundle contract, which is reported separately as bundle_schema_version.
API_VERSION = "1.1"
UI_ROOT = Path(__file__).resolve().parents[2] / "extension"
UI_FILES = {"options/options.html", "options/options.js", "options/options.css", "options/automation-state.js", "shared/constants.js"}


def _origin(handler):
    origin = handler.headers.get("Origin", "")
    try:
        parsed = urlsplit(origin)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            return None
        if parsed.scheme == "chrome-extension" and parsed.netloc and not parsed.path:
            return origin
        if (parsed.scheme in ("http", "https") and parsed.hostname in ("127.0.0.1", "localhost", "::1")
                and not parsed.path and parsed.port == handler.server.server_port):
            return origin
    except ValueError:
        return None
    return None


def _headers(handler):
    allowed = _origin(handler)
    if allowed:
        handler.send_header("Access-Control-Allow-Origin", allowed)
        handler.send_header("Vary", "Origin")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")


def _json(handler, code, payload):
    body = json.dumps(payload, allow_nan=False).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    _headers(handler)
    handler.end_headers()
    handler.wfile.write(body)


def _parse_body(handler):
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        raise ValueError("Invalid Content-Length") from None
    if not 0 <= length <= UPLOAD_LIMIT:
        raise ValueError("Request body exceeds the 64 MiB limit")
    body = handler.rfile.read(length)
    if len(body) != length:
        raise ValueError("Incomplete request body")
    automation.require_browser_active()
    return body


def _body_json(handler):
    if handler.headers.get_content_type() != "application/json":
        raise ValueError("Expected application/json")
    try:
        data = json.loads(_parse_body(handler) or b"{}")
    except (ValueError, UnicodeError):
        raise ValueError("Invalid JSON") from None
    if not isinstance(data, dict):
        raise ValueError("Expected a JSON object")
    return data


def _live_insight_body(handler):
    """Apply the small live-input cap before reading any request bytes."""
    if handler.headers.get_content_type() != "application/json":
        raise ValueError("Expected application/json")
    if handler.headers.get("Transfer-Encoding"):
        handler.close_connection = True
        raise ValueError("Live interpretation requires a bounded Content-Length")
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        handler.close_connection = True
        raise ValueError("Invalid Content-Length") from None
    if not 0 < length <= live_insights.MAX_BODY_BYTES:
        handler.close_connection = True
        raise ValueError("Live interpretation body exceeds its bounded limit or is empty")
    body = handler.rfile.read(length)
    if len(body) != length:
        raise ValueError("Incomplete request body")
    return live_insights.parse_json(body)


def _parse_multipart(handler):
    """Use the stdlib MIME parser; never strip binary recording bytes."""
    header = handler.headers.get("Content-Type", "")
    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + header.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + _parse_body(handler)
    )
    if not message.is_multipart():
        raise ValueError("Invalid multipart body")
    fields, files = {}, {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name or name in fields or name in files:
            raise ValueError("Missing or duplicate multipart field")
        value = part.get_payload(decode=True) or b""
        if part.get_filename() is not None:
            files[name] = value
        else:
            fields[name] = value.decode("utf-8")
    return fields, files


def _text(value, limit):
    if not isinstance(value, str):
        raise ValueError("Expected text")
    if len(value) > limit:
        raise ValueError(f"Text exceeds {limit} characters")
    return value


def _query_format(handler):
    """The requested output format, or an empty string for the default."""
    query = urlsplit(handler.path).query
    for pair in query.split("&"):
        key, _, value = pair.partition("=")
        if key == "format":
            return value[:40]
    return ""


def _safe_url(value):
    value = _text(value, 8192)
    if not value:
        return ""
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Capture URL must be HTTP or HTTPS")
    route = parsed.fragment if all(c.isalnum() or c in "-_/." for c in parsed.fragment) else ""
    host = parsed.hostname
    if ":" in host:
        host = f"[{host}]"
    if parsed.port:
        host += f":{parsed.port}"
    return f"{parsed.scheme}://{host}{parsed.path}" + (f"#{route}" if route else "")


def _public_record(entry):
    return {key: value for key, value in entry.items() if not key.endswith("_path") and key != "inference"}


def _record(handler):
    video = b""
    if handler.headers.get_content_type() == "multipart/form-data":
        data, files = _parse_multipart(handler)
        video = files.get("video", b"")
        for key in ("events", "screenshots"):
            data[key] = json.loads(data.get(key, "[]"))
        if "automation" in data:
            data["automation"] = json.loads(data["automation"])
        data["consent"] = data.get("consent") == "true"
        data["screenshotsConsent"] = data.get("screenshotsConsent") == "true"
    else:
        data = _body_json(handler)
    if data.get("consent") is not True:
        raise ValueError("Explicit session consent is required")
    events = data.get("events", [])
    screenshots = data.get("screenshots", [])
    if not isinstance(events, list) or len(events) > 5000 or any(not isinstance(e, dict) for e in events):
        raise ValueError("Expected at most 5000 event objects")
    events = sanitize_events(events)
    if not isinstance(screenshots, list) or len(screenshots) > 20:
        raise ValueError("Expected at most 20 screenshots")
    if screenshots and data.get("screenshotsConsent") is not True:
        raise ValueError("Screenshot consent is required; pixels are not automatically redacted")
    clean_screenshots = []
    for shot in screenshots:
        if not isinstance(shot, dict) or not isinstance(shot.get("dataUrl"), str):
            raise ValueError("Invalid screenshot")
        encoded = shot["dataUrl"]
        prefix = "data:image/jpeg;base64,"
        if not encoded.startswith(prefix) or len(encoded) > 5_000_000:
            raise ValueError("Screenshots must be bounded JPEG data URLs")
        try:
            raw = base64.b64decode(encoded[len(prefix):], validate=True)
            if not raw.startswith(b"\xff\xd8"):
                raise ValueError("Invalid JPEG")
        except ValueError:
            raise ValueError("Invalid screenshot encoding") from None
        timestamp = shot.get("ts")
        if (not isinstance(timestamp, (int, float)) or isinstance(timestamp, bool)
                or not math.isfinite(timestamp) or timestamp <= 0):
            raise ValueError("Screenshot timestamp must be epoch milliseconds")
        clean_screenshots.append({"ts": timestamp, "dataUrl": encoded})
    screenshots = clean_screenshots
    session_id = _text(data.get("sessionId", ""), 200)
    extension_id = _text(data.get("extensionId", "unknown"), 200)
    if not session_id:
        raise ValueError("sessionId is required for retry-safe capture")
    try:
        start = float(data["startTime"]) / 1000
        end = float(data["endTime"]) / 1000
        tab = int(data.get("tabId", 0))
    except (ValueError, TypeError, KeyError):
        raise ValueError("Expected startTime/endTime in epoch milliseconds and numeric tabId") from None
    if not math.isfinite(start) or not math.isfinite(end) or start <= 0 or end < start:
        raise ValueError("Invalid capture timestamps")
    url = _safe_url(data.get("url", ""))
    title = _text(data.get("title", ""), 500)
    goal = _text(data.get("goal", ""), 2000)
    policy = automation.admit_policy(data.get("automation"), start)
    with storage.DATA_LOCK:
        automation.require_browser_active()
        rid = storage.recording_id_for_session(extension_id, session_id)
        automation.require_not_cancelled(rid)
        existing = storage.get_recording(rid)
        if existing:
            if policy is not None:
                original = existing.get("automation") or {}
                keys = ("enabled", "consent", "target_url", "use_ai", "max_tickets", "consented_at", "expires_at")
                if any(original.get(key) != policy.get(key) for key in keys):
                    raise ValueError("An existing capture's delivery policy cannot be changed; start a new capture")
            state = automation.enqueue(existing) if existing.get("automation") else None
            _json(handler, 200, {"id": rid, "event_count": existing["event_count"], "cached": True, "automation": state})
            return
        storage.ensure_dirs()
        video_path = storage.RECORDINGS_DIR / f"{rid}.webm" if video else None
        if video_path:
            with open(video_path, "xb") as output:
                output.write(video)
            video_path.chmod(0o600)
        events_path = storage.EVENTS_DIR / f"{rid}.json"
        shots_path = storage.RECORDINGS_DIR / f"{rid}_screenshots.json"
        storage.write_json(events_path, events)
        storage.write_json(shots_path, screenshots)
        storage.create_recording(
            recording_id=rid, session_id=session_id, tab_id=tab, start_time=start, end_time=end,
            event_count=len(events), screenshot_count=len(screenshots), extension_id=extension_id,
            video_path=video_path, events_path=events_path, screenshots_path=shots_path,
            video_size=len(video), url=url, title=title, goal=goal,
            metadata={"consent": True, "screenshots_consent": bool(screenshots),
                      "capture_mode": "video" if video else "events",
                      "diagnostic_count": sum(1 for event in events if event.get("type") == "diagnostic")},
            automation_policy=policy,
        )
        state = automation.enqueue(storage.get_recording(rid)) if policy else None
    _json(handler, 201, {"id": rid, "event_count": len(events), "cached": False, "automation": state})


def _load_events(entry):
    path = entry.get("events_path")
    return json.loads(Path(path).read_text()) if path else []


def _draft_response(saved, cached):
    _check_draft_revision(saved)
    return {"id": saved["id"], **saved["data"], "cached": cached}


def _check_draft_revision(saved):
    if saved and saved["data"].get("mode") == "ai" and saved["data"].get("generation_revision", 0) < GENERATION_REVISION:
        raise ValueError("This AI draft was generated by an earlier version and needs regeneration to include the current evidence")


def _reviewed_ticket(entry, data):
    saved = load_tickets(entry["id"])
    if not saved:
        raise ValueError("Generate drafts before previewing delivery")
    _check_draft_revision(saved)
    ticket = next((dict(t) for t in saved["data"]["tickets"] if t["id"] == data.get("ticket_id")), None)
    if ticket is None:
        raise ValueError("Unknown draft ticket")
    patch = data.get("patch", {})
    if not isinstance(patch, dict) or set(patch) - {"title", "description", "acceptance_criteria"}:
        raise ValueError("Only title, description and acceptance criteria can be edited")
    for key in ("title", "description"):
        if key in patch:
            ticket[key] = _text(patch[key], 200 if key == "title" else 2000).strip()
    if not ticket.get("title"):
        raise ValueError("Ticket title is required")
    if "acceptance_criteria" in patch:
        values = patch["acceptance_criteria"]
        if not isinstance(values, list) or len(values) > 10:
            raise ValueError("Expected up to 10 acceptance criteria")
        ticket["acceptance_criteria"] = [_text(v, 500) for v in values if v]
    # Record which fields a reviewer actually changed. A later regeneration
    # must not discard that decision, and must not treat untouched fields as
    # reviewed.
    reviewed = dict(ticket.get("reviewed") or {})
    for key in ("title", "description", "acceptance_criteria"):
        if key in patch:
            reviewed[key] = ticket[key]
    if reviewed:
        ticket["reviewed"] = reviewed
    return ticket


def _serve_ui(handler, path):
    if path == "/":
        handler.send_response(302)
        handler.send_header("Location", "/ui/options/options.html")
        handler.end_headers()
        return True
    if not path.startswith("/ui/"):
        return False
    relative = path[4:]
    if relative not in UI_FILES:
        _json(handler, 404, {"error": "not found"})
        return True
    body = (UI_ROOT / relative).read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", mimetypes.guess_type(relative)[0] or "application/octet-stream")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self'; frame-ancestors 'none'")
    _headers(handler)
    handler.end_headers()
    handler.wfile.write(body)
    return True


def handle_request(handler: BaseHTTPRequestHandler):
    try:
        try:
            automation.require_browser_active()
        except ValueError as exc:
            handler.close_connection = True
            _json(handler, 503, {"error": str(exc)})
            return
        host = urlsplit("http://" + handler.headers.get("Host", "")).hostname
        if host not in ("127.0.0.1", "localhost", "::1"):
            _json(handler, 403, {"error": "Loopback Host required"})
            return
        if handler.headers.get("Origin") and not _origin(handler):
            _json(handler, 403, {"error": "Origin not permitted"})
            return
        method = handler.command
        if method == "OPTIONS":
            handler.send_response(204)
            _headers(handler)
            handler.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-Panther-Client")
            handler.end_headers()
            return
        if method in ("POST", "DELETE") and not handler.headers.get("X-Panther-Client"):
            _json(handler, 403, {"error": "X-Panther-Client header required"})
            return
        path = urlsplit(handler.path).path
        if method == "GET" and _serve_ui(handler, path):
            return
        prefix = "/api/extension/"
        if not path.startswith(prefix):
            _json(handler, 404, {"error": "not found"})
            return
        parts = path[len(prefix):].strip("/").split("/")
        if parts == ["health"] and method == "GET":
            _json(handler, 200, {"status": "ok", "service": "panther-intent-capture-backend", "schema_version": API_VERSION,
                                 "bundle_schema_version": SCHEMA_VERSION,
                                 "capabilities": ["events", "screenshots", "diagnostics", "drafts", "json-export", "ticket-service", "automatic-delivery"]})
            return
        if parts == ["record"] and method == "POST":
            _record(handler)
            return
        if parts == ["live-insight"] and method == "POST":
            _json(handler, 200, live_insights.analyze(_live_insight_body(handler)))
            return
        if parts == ["recordings"] and method == "GET":
            _json(handler, 200, {"recordings": storage.list_recordings()})
            return
        if parts == ["integrations"] and method == "GET":
            _json(handler, 200, {"destinations": destinations.catalogue()})
            return
        if len(parts) == 2 and parts[0] == "integrations" and destinations.known(parts[1]) and method == "GET":
            _json(handler, 200, destinations.status(parts[1]))
            return
        if len(parts) == 2 and parts[0] == "automation":
            if method == "GET":
                _json(handler, 200, automation.status(parts[1]))
            elif method == "POST":
                data = _body_json(handler)
                if set(data) != {"action"}:
                    raise ValueError("Automation controls accept only an action")
                _json(handler, 200, automation.control(parts[1], data["action"]))
            else:
                _json(handler, 405, {"error": "Method not allowed"})
            return
        if len(parts) == 2 and parts[0] == "recordings" and method == "DELETE":
            automation.control(parts[1], "cancel")
        integration = (len(parts) == 4 and parts[0] == "integrations"
                       and destinations.known(parts[1]) and parts[2] in ("preview", "submit"))
        if not integration and (len(parts) not in (2, 3) or parts[0] not in ("recordings", "tickets", "export", "infer")):
            _json(handler, 404, {"error": "not found"})
            return
        rid = parts[3] if integration else parts[1]
        entry = storage.get_recording(rid)
        if entry is None:
            _json(handler, 404, {"error": "Recording not found"})
            return
        if (method == "POST" and entry.get("automation")
                and (parts[0] == "tickets" or (integration and parts[2] == "submit"))
                and automation.is_active(rid)):
            _json(handler, 409, {"error": "Automatic delivery is active with frozen drafts; cancel it before manual generation, editing, or sending"})
            return
        if integration and method == "POST":
            data = _body_json(handler)
            ticket = _reviewed_ticket(entry, data)
            preview = destinations.preview(parts[1], entry, ticket)
            if parts[2] == "preview":
                _json(handler, 200, preview)
            elif data.get("confirmed") is not True or data.get("payload_hash") != preview["payload_hash"]:
                _json(handler, 409, {"error": "Preview and explicitly confirm this exact ticket before sending"})
            else:
                result = destinations.submit(parts[1], entry, ticket)
                _json(handler, 200 if result.get("ok") else 409, result)
            return
        if parts[0] == "recordings":
            if method == "DELETE" and len(parts) == 2:
                _json(handler, 200, {"deleted": storage.delete_recording(rid)})
            elif method == "GET" and len(parts) == 2:
                _json(handler, 200, _public_record(entry))
            elif method == "GET" and parts[-1] == "events":
                _json(handler, 200, {"events": _load_events(entry)})
            elif method == "GET" and parts[-1] == "diagnostics":
                _json(handler, 200, capture_diagnostics(sanitize_events(_load_events(entry))))
            elif method == "GET" and parts[-1] == "replay":
                plan = replay.build_plan(entry, sanitize_events(_load_events(entry)))
                if _query_format(handler) == "playwright":
                    body = replay.render_playwright(plan).encode()
                    handler.send_response(200)
                    handler.send_header("Content-Type", "text/plain; charset=utf-8")
                    handler.send_header("Content-Length", str(len(body)))
                    _headers(handler)
                    handler.end_headers()
                    handler.wfile.write(body)
                    return
                _json(handler, 200, plan)
            elif method == "GET" and parts[-1] == "screenshots":
                shot_path = entry.get("screenshots_path")
                # Screenshot pixels are intentionally retained for review but are
                # not redacted by the current capture pipeline. Keep that state
                # explicit in the API so consumers cannot mistake image presence
                # for privacy qualification.
                _json(handler, 200, {
                    "screenshots": json.loads(Path(shot_path).read_text()) if shot_path else [],
                    "redaction_status": "not_redacted",
                    "review_required": True,
                })
            else:
                _json(handler, 404, {"error": "Media playback is not supported in this capture release"})
            return
        if parts[0] == "tickets" and len(parts) == 3 and parts[2] == "review" and method == "POST":
            data = _body_json(handler)
            with storage.DATA_LOCK:
                ticket = _reviewed_ticket(entry, data)
                saved = load_tickets(rid)
                saved["data"]["tickets"] = [ticket if t["id"] == ticket["id"] else t for t in saved["data"]["tickets"]]
                save_tickets(rid, saved["data"])
            _json(handler, 200, {"saved": True, "ticket": ticket})
            return
        if parts[0] == "tickets" and len(parts) == 2 and method in ("GET", "POST"):
            saved = load_tickets(rid)
            if method == "GET":
                _json(handler, 200 if saved else 404, _draft_response(saved, True) if saved else {"error": "No drafts generated yet"})
                return
            data = _body_json(handler)
            use_ai = data.get("use_ai", False)
            if not isinstance(use_ai, bool):
                raise ValueError("use_ai must be a boolean")
            mode = "ai" if use_ai else "observed"
            with storage.DATA_LOCK:
                saved = load_tickets(rid, mode=mode)
                if saved:
                    save_tickets(rid, saved["data"])
                    _json(handler, 200, _draft_response(saved, True))
                    return
            generated = generate_drafts(entry, _load_events(entry), use_ai=use_ai)
            with storage.DATA_LOCK:
                if not storage.get_recording(rid):
                    raise ValueError("Recording was deleted during draft generation")
                concurrent = load_tickets(rid, mode=mode)
                save_tickets(rid, concurrent["data"] if concurrent else generated)
                saved = load_tickets(rid)
            _json(handler, 200, _draft_response(saved, False))
            return
        if parts[0] == "export" and len(parts) == 2 and method == "GET":
            saved = load_tickets(rid)
            if not saved:
                raise ValueError("Generate drafts before exporting")
            _check_draft_revision(saved)
            _json(handler, 200, export_bundle(entry, saved["data"]))
            return
        _json(handler, 404, {"error": "not found"})
    except live_insights.LiveInsightError as exc:
        _json(handler, exc.status, {"error": str(exc), "retryable": exc.status != 503})
    except DraftGenerationError as exc:
        _json(handler, 502, {"error": str(exc), "retryable": True})
    except (ValueError, TypeError, KeyError, UnicodeError) as exc:
        _json(handler, 400, {"error": str(exc)})
    except Exception as exc:
        _json(handler, 500, {"error": "Backend operation failed; check the local server log"})
        handler.log_error("%s", type(exc).__name__)
