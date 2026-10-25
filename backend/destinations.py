"""The destinations Panther can deliver a reviewed draft to.

Every destination provides the same contract: a status that never reads
another system's data, a canonical target, a preview that never contacts the
destination, a confirmed submit that verifies what it created, and a durable
receipt keyed by that target. Adding a destination means implementing that
contract and listing it here.
"""
from __future__ import annotations

from typing import Any, Dict, List

import github
import integrations

TICKET_SERVICE = "ticket-service"
GITHUB = "github"

# The adapter functions are resolved when they are called, not when this
# module is imported, so a test or a caller can replace one without
# re-importing the registry.
_ADAPTERS = {
    TICKET_SERVICE: {
        "label": "Local ticket service",
        "status": (integrations, "dashboard_status"),
        "target": (integrations, "_target"),
        "preview": (integrations, "preview_ticket"),
        "submit": (integrations, "submit_ticket"),
    },
    GITHUB: {
        "label": "GitHub issues",
        "status": (github, "status"),
        "target": (github, "target"),
        "preview": (github, "preview_ticket"),
        "submit": (github, "submit_ticket"),
    },
}


def _call(kind: str, role: str, *args, **kwargs):
    if kind not in _ADAPTERS:
        raise ValueError("Unknown delivery destination")
    module, name = _ADAPTERS[kind][role]
    return getattr(module, name)(*args, **kwargs)


def kinds() -> List[str]:
    return list(_ADAPTERS)


def known(kind: str) -> bool:
    return kind in _ADAPTERS


def label(kind: str) -> str:
    return _ADAPTERS.get(kind, {}).get("label", kind)


def status(kind: str) -> Dict[str, Any]:
    return _call(kind, "status")


def target(kind: str) -> str:
    return _call(kind, "target")


def preview(kind: str, recording: dict, ticket: dict) -> Dict[str, Any]:
    return _call(kind, "preview", recording, ticket)


def submit(kind: str, recording: dict, ticket: dict, *, before_send=None) -> Dict[str, Any]:
    return _call(kind, "submit", recording, ticket, before_send=before_send)


def catalogue() -> List[Dict[str, Any]]:
    """Every destination with its status, so a client can choose explicitly.

    A destination that is not configured is still listed, so a client can say
    why it is unavailable rather than silently omitting it.
    """
    catalogue = []
    for kind in _ADAPTERS:
        try:
            report = status(kind)
        except ValueError as exc:
            report = {"ok": False, "state": "unavailable", "url": "", "error": str(exc)[:200]}
        catalogue.append({
            "kind": kind,
            "label": label(kind),
            "available": report.get("ok") is True,
            "configured": bool(report.get("url")),
            "state": report.get("state", "unknown"),
            "url": report.get("url", ""),
            "detail": report.get("detail", ""),
            "error": report.get("error", ""),
        })
    return catalogue
