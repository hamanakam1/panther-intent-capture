"""Secret redaction for the extension backend (defense in depth).

Mirrors the extension's frontend redaction so that secrets are never
persisted even if a client posts directly to the backend. The two
implementations are held to the same behaviour by
``tests/test_redaction_parity.py``; keep them in step.
"""

from __future__ import annotations

import math
import re
import time
from typing import Any
from urllib.parse import unquote, urlsplit, urlunsplit

REDACT_FIELD_NAMES = {
    "password", "passwd", "pwd", "secret", "apikey", "api_key",
    "access_key", "secret_key", "token", "authorization", "credential",
    "private_key", "session_id", "auth", "cookie",
}
REDACT_FIELD_IDS = {
    "password", "passwd", "secret", "apikey", "api_key",
    "access_key", "secret_key", "token", "credential",
    "private_key", "session_id",
}
_SECRET_PATTERNS = [
    re.compile(r"secret|token|key|pass|cred|auth|cookie", re.IGNORECASE),
]
# URL rules also treat a session segment as secret: the extension redacts the
# path segment after a session-like part, because a session identifier is a
# credential in disguise. Field names keep the narrower rule, so a field called
# "session_count" stays readable.
_URL_SECRET_PATTERNS = [
    re.compile(r"secret|token|key|pass|cred|auth|cookie|session", re.IGNORECASE),
]

# Page-failure channels. This mirrors the extension's DIAGNOSTIC_KINDS set
# exactly; a new kind needs a matching change in the extension and a
# redaction-parity update.
DIAGNOSTIC_KINDS = {
    "uncaught_exception",
    "unhandled_rejection",
    "http_error",
    "resource_error",
}
MAX_DIAGNOSTIC_MESSAGE = 300
MAX_DIAGNOSTIC_SOURCE = 1000
MAX_DIAGNOSTIC_POSITION = 1000000


def sanitize_url(value: Any) -> str:
    """Keep page identity without credentials, query secrets or arbitrary hashes."""
    if not isinstance(value, str) or len(value) > 8192:
        return ""
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return ""
        host = parsed.hostname
        if ":" in host:
            host = f"[{host}]"
        if parsed.port:
            host += f":{parsed.port}"
        fragment = parsed.fragment if re.fullmatch(r"/?[A-Za-z][A-Za-z0-9_/-]{0,100}", parsed.fragment) else ""
        parts = parsed.path.split("/")
        path = "/".join("REDACTED" if len(part) > 48 or (index and _looks_secret(unquote(parts[index - 1]), _URL_SECRET_PATTERNS))
                        else part for index, part in enumerate(parts))
        if _looks_secret(fragment, _URL_SECRET_PATTERNS):
            fragment = ""
        return urlunsplit((parsed.scheme, host, path, "", fragment))[:1000]
    except ValueError:
        return ""


def _looks_secret(key: str, patterns: list[re.Pattern[str]] | None = None) -> bool:
    k = str(key).lower()
    if k in REDACT_FIELD_NAMES or k in REDACT_FIELD_IDS:
        return True
    return any(p.search(k) for p in (patterns or _SECRET_PATTERNS))


def _scrub_value(value: Any) -> Any:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, bool):
        return value
    if isinstance(value, list):
        return [_scrub_value(v) for v in value]
    if isinstance(value, dict):
        sensitive = any(_looks_secret(value.get(key, "")) for key in ("name", "id", "type", "autocomplete"))
        result = {}
        for key, item in value.items():
            if _looks_secret(key) or (sensitive and key in ("value", "text", "label", "input")):
                result[key] = "***REDACTED***"
            elif str(key).lower() in ("url", "href", "page_url", "source_url"):
                result[key] = sanitize_url(item)
            else:
                result[key] = _scrub_value(item)
        return result
    return value


def sanitize_event_payload(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return payload
    return _scrub_value(payload)


def sanitize_text(value: Any, limit: int = 120) -> str:
    if not isinstance(value, str):
        return ""
    text = re.sub(r"\bBearer\s+[a-z0-9._~+/-]+=*", "[REDACTED]", value, flags=re.I)
    text = re.sub(r"\b(?:sk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]+", "[REDACTED]", text, flags=re.I)
    text = re.sub(r"\b(?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+", "[REDACTED]", text, flags=re.I)
    text = re.sub(r"[a-z0-9.!#$%&'*+/=?^_{}|~-]+@[a-z0-9.-]+\.[a-z]{2,}", "[EMAIL]", text, flags=re.I)
    text = re.sub(r"\b[a-z0-9_-]{40,}\b", "[REDACTED]", text, flags=re.I)
    return re.sub(r"[\x00-\x1f\x7f]", " ", text)[:limit]


def _event_timestamp(value: Any) -> int:
    """The event timestamp, defaulting to now like the extension does.

    An event without a usable timestamp still has to carry one: the ticket
    references and the model's relative timing read it. Dropping it would make
    evidence disappear from the reproduction steps.
    """
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return int(value)
    return int(time.time() * 1000)


def sanitize_diagnostic(payload: Any, timestamp: int) -> Any:
    """Retain a page-reported failure from an allowlist of fields.

    A failure is what the page itself reported. The message is the page's own
    error text, so it is treated as untrusted data: scrubbed for common secret
    shapes and bounded. The location is a URL and is sanitized like every other
    captured URL. Nothing here reads page body text or typed values.
    """
    if not isinstance(payload, dict):
        return None
    raw = payload.get("diagnostic")
    if not isinstance(raw, dict):
        return None
    kind = raw.get("kind")
    if not isinstance(kind, str) or kind not in DIAGNOSTIC_KINDS:
        return None
    diagnostic: dict[str, Any] = {"kind": kind}
    message = raw.get("message")
    if isinstance(message, str):
        cleaned = sanitize_text(message, MAX_DIAGNOSTIC_MESSAGE)
        if cleaned.strip():
            diagnostic["message"] = cleaned
    source = raw.get("source")
    if isinstance(source, str):
        cleaned = sanitize_url(source[:MAX_DIAGNOSTIC_SOURCE])
        if cleaned:
            diagnostic["source"] = cleaned
    status = raw.get("status")
    if kind == "http_error":
        # An HTTP failure without a readable status is not an HTTP failure.
        # The status is what makes the record meaningful, so it is required.
        if not isinstance(status, int) or isinstance(status, bool) or not 400 <= status <= 599:
            return None
        diagnostic["status"] = status
    if kind == "uncaught_exception":
        for key in ("line", "column"):
            value = raw.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_DIAGNOSTIC_POSITION:
                diagnostic[key] = value
    # A record with nothing to show is not evidence; drop it rather than
    # delivering an empty line to a reviewer.
    if not diagnostic.get("message") and not diagnostic.get("source") and "status" not in diagnostic:
        return None
    return {"type": "diagnostic", "ts": timestamp, "url": sanitize_url(payload.get("url")), "diagnostic": diagnostic}


def sanitize_capture_event(payload: Any) -> Any:
    """Retain semantic interactions only; never typed keys, values or page text.

    The allowlist mirrors the extension exactly: a label is only kept when the
    extension would have sent one, and page text is never read from a
    ``text`` field, because the extension never sends one.
    """
    if not isinstance(payload, dict):
        return None
    if payload.get("type") == "diagnostic":
        return sanitize_diagnostic(payload, _event_timestamp(payload.get("ts")))
    if payload.get("type") not in ("click", "change", "submit", "navigation"):
        return None
    event = {
        "type": payload["type"],
        "ts": _event_timestamp(payload.get("ts")),
        "url": sanitize_url(payload.get("url")),
    }
    target = payload.get("target")
    if isinstance(target, dict):
        semantic = {}
        for key in ("tag", "role", "id", "type", "dataTab", "dataTicket"):
            value = target.get(key)
            if isinstance(value, str) and value:
                semantic[key] = sanitize_text(value)
        tag = semantic.get("tag", "").lower()
        if tag in ("button", "a"):
            label = target.get("label")
            if isinstance(label, str) and label:
                semantic["label"] = sanitize_text(label)
        href = target.get("href")
        if isinstance(href, str) and href:
            semantic["href"] = sanitize_url(href)
        # A click on an element the page never marked as a control. Only the
        # extension's own true flag is kept.
        if target.get("inert") is True:
            semantic["inert"] = True
        event["target"] = semantic
    return event


def sanitize_events(events: Any) -> Any:
    if not isinstance(events, list):
        return events
    return [clean for event in events if (clean := sanitize_capture_event(event)) is not None]
