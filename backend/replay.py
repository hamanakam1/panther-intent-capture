"""Build a replay plan for a captured flow.

The plan is a proposal for a person to review. Panther never runs it, and it
never carries a value the capture did not record. Panther does not capture
typed values, so a plan can describe the path a person took — where they went
and what they pressed — but it cannot reproduce what they typed.
"""
from __future__ import annotations

import json
import re
import time
from typing import Any, Dict, List, Optional

from redaction import sanitize_url
from tickets import _diagnostics, _friction

SCHEMA = "https://github.com/hamanakam1/panther-intent-capture#replay-plan"
SCHEMA_VERSION = "1.0"
MAX_STEPS = 200
MAX_LABEL = 120
MAX_VALUE = 120
# An identifier that a page could regenerate, or that carries no meaning, is
# not a stable handle. Only a plain, short identifier is offered as one.
_STABLE_ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,48}\Z")
_REDACTED = ("REDACTED", "[EMAIL]", "[REDACTED]")


def _text(value: Any, limit: int = MAX_LABEL) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _usable(value: Any) -> bool:
    """A captured value is only usable when it was not redacted or truncated."""
    if not isinstance(value, str) or not value:
        return False
    return not any(marker in value for marker in _REDACTED)


def _css_attribute(attribute: str, value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'[{attribute}="{escaped}"]'


def _selector(target: Dict[str, Any]) -> Dict[str, Any]:
    """Choose the most stable handle available for a control.

    The order matters: a test identifier is meant to be stable, an element id
    usually is, an accessible name usually is, and a visible string is the
    weakest. When nothing is available the step is not replayable and says so.
    """
    empty = {"strategy": "none", "value": None, "attribute": None, "role": None, "css": None, "replayable": False}
    tag = _text(target.get("tag"), 40).lower()
    # The capture names these attributes in camel case; the attribute they
    # stand for on the page is the kebab-case form.
    for key, attribute in (("dataTicket", "data-ticket"), ("dataTab", "data-tab")):
        value = target.get(key)
        if _usable(value) and len(value) <= MAX_VALUE:
            return {"strategy": "test-id", "value": value, "attribute": attribute, "role": None,
                    "css": _css_attribute(attribute, value), "replayable": True}
    identifier = target.get("id")
    if _usable(identifier) and _STABLE_ID.fullmatch(identifier):
        return {"strategy": "id", "value": identifier, "attribute": "id", "role": None,
                "css": f"#{identifier}", "replayable": True}
    role = _text(target.get("role"), 40).lower()
    label = _text(target.get("label"), MAX_LABEL)
    if role and label:
        return {"strategy": "role-name", "value": label, "attribute": None, "role": role,
                "css": None, "replayable": True}
    if label and tag in ("button", "a"):
        return {"strategy": "text", "value": label, "attribute": None, "role": None,
                "css": None, "replayable": True}
    href = target.get("href")
    if _usable(href) and tag == "a":
        path = sanitize_url(href)
        if path:
            return {"strategy": "href", "value": path, "attribute": "href", "role": None,
                    "css": None, "replayable": True}
    return empty


def _step(index: int, action: str, event: Dict[str, Any], note: str = "") -> Dict[str, Any]:
    target = event.get("target") if isinstance(event.get("target"), dict) else {}
    selector = _selector(target)
    step = {
        "index": index,
        "action": action,
        "url": sanitize_url(event.get("url")),
        "selector": selector,
        "label": _text(target.get("label"), MAX_LABEL),
        "replayable": bool(selector["replayable"]) and action in ("navigate", "click", "submit"),
    }
    if note:
        step["note"] = note[:300]
    return step


def _navigate_step(index: int, url: str) -> Dict[str, Any]:
    return {
        "index": index,
        "action": "navigate",
        "url": url,
        "selector": {"strategy": "none", "value": None, "attribute": None, "role": None, "css": None, "replayable": False},
        "label": "",
        "replayable": True,
    }


def build_plan(recording: Dict[str, Any], events: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Return a destination-neutral plan for replaying a captured flow."""
    steps: List[Dict[str, Any]] = []
    current_url = ""
    # The plan always begins by opening the captured page, so a replayer knows
    # where the flow started even when the capture recorded no navigation.
    start_url = sanitize_url(recording.get("url"))
    if start_url:
        current_url = start_url
        steps.append(_navigate_step(1, start_url))
    for event in events[:MAX_STEPS]:
        if not isinstance(event, dict) or len(steps) >= MAX_STEPS:
            continue
        kind = event.get("type")
        if kind == "navigation":
            url = sanitize_url(event.get("url"))
            if url and url != current_url:
                current_url = url
                steps.append(_navigate_step(len(steps) + 1, url))
            continue
        if kind == "click":
            steps.append(_step(len(steps) + 1, "click", event))
        elif kind == "submit":
            steps.append(_step(len(steps) + 1, "submit", event))
        elif kind == "change":
            steps.append(_step(len(steps) + 1, "change", event,
                               "The value of this field was never captured, so the step records that it changed, not what it became."))
        elif kind == "diagnostic":
            continue
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "producer": "panther-intent-capture",
        "generated_at": time.time(),
        "recording": {
            "id": recording.get("id"),
            "source_url": sanitize_url(recording.get("url")),
            "capture_mode": _text(recording.get("capture_mode"), 30),
            "stated_goal": _text(recording.get("goal"), 2000),
        },
        "steps": steps,
        "observations": _diagnostics(events),
        "friction": _friction(events),
        "limits": {
            "values_captured": False,
            "screenshots_analyzed": False,
            "executed_by_producer": False,
            "requires_review": True,
            "note": ("Panther does not capture typed values, so this plan describes the path that was taken, "
                     "not the data that was entered. It is a proposal for a person to review."),
        },
        "authority": {"export_only": True, "requires_review": True, "execution_authorized": False},
    }


def _playwright_locator(selector: Dict[str, Any]) -> Optional[str]:
    """Render one selector as a Playwright call, or nothing when it is unsafe."""
    strategy = selector.get("strategy")
    value = selector.get("value")
    css = selector.get("css")
    if strategy == "test-id" and css:
        return f'page.locator({json.dumps(css)})'
    if strategy == "id" and css:
        return f'page.locator({json.dumps(css)})'
    if strategy == "role-name" and value:
        role = selector.get("role") or "button"
        return f"page.get_by_role({json.dumps(role)}, name={json.dumps(value)})"
    if strategy == "text" and value:
        return f"page.get_by_text({json.dumps(value)})"
    if strategy == "href" and value:
        return f"page.locator('a[href={json.dumps(value)}]')"
    return None


def render_playwright(plan: Dict[str, Any]) -> str:
    """Render a plan as a reviewable Playwright script.

    The script is a proposal. Panther does not run it, and it contains no
    captured value because no value was ever captured.
    """
    lines = [
        "# Generated by Panther Intent Capture from capture "
        f"{plan.get('recording', {}).get('id', 'unknown')}.",
        "# This is a proposal for a person to review. Panther never runs it.",
        "# No typed value is present, because Panther never captured one.",
        "",
        "from playwright.sync_api import sync_playwright",
        "",
        "",
        "def replay():",
        "    with sync_playwright() as playwright:",
        "        browser = playwright.chromium.launch()",
        "        page = browser.new_page()",
    ]
    for step in plan.get("steps", []):
        action = step.get("action")
        if action == "navigate":
            lines.append(f"        page.goto({json.dumps(step.get('url', ''))})")
            continue
        if not step.get("replayable"):
            continue
        locator = _playwright_locator(step.get("selector") or {})
        if not locator:
            continue
        if action == "click":
            lines.append(f"        {locator}.click()")
        elif action == "submit":
            # A form is submitted, not clicked.
            lines.append(f'        {locator}.evaluate("form => form.requestSubmit()")')
    lines.append("        browser.close()")
    lines.append("")
    lines.append("")
    lines.append('if __name__ == "__main__":')
    lines.append("    replay()")
    lines.append("")
    return "\n".join(lines)
