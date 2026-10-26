#!/usr/bin/env python3
"""Capture the Panther Intent Capture screenshots from the real backend.

Every pixel in ``docs/screenshots/*.png`` comes from the real product. The
script starts the actual backend, records a synthetic capture through the
actual API, and photographs the actual options page with a real browser.

Nothing is mocked, hand-drawn or illustrated. The capture is synthetic on
purpose: the origin, the page and the ticket data are fictional, so nothing
here identifies a real system or deployment.

Usage::

    python3 scripts/capture_screenshots.py

The script needs a Chromium-family browser for the screenshot. It looks for
Google Chrome, Microsoft Edge and Brave, in that order. The backend itself
needs nothing but the Python standard library.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO / "docs" / "screenshots"

sys.path.insert(0, str(Path(__file__).resolve().parent))

from term2png import FontBook, session  # noqa: E402

BROWSERS = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
)

#: A fictional checkout. Nothing here refers to a real site or a real system.
DEMO_ORIGIN = "https://orders.example.test"
DEMO_TITLE = "Checkout - orders.example.test"
DEMO_GOAL = "Applying a promo code at checkout should not discard the entered code"


def find_browser() -> str:
    for candidate in BROWSERS:
        if Path(candidate).exists():
            return candidate
    raise SystemExit(
        "no Chromium-family browser found; install Chrome, Edge or Brave to capture the UI"
    )


def free_port() -> int:
    """Ask the kernel for a port nobody is using."""

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def request(url: str, payload: dict | None = None, timeout: int = 10) -> tuple[int, str]:
    """Call the backend and return the status and the body it wrote."""

    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"X-Panther-Client": "screenshot-capture"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def start_backend(port: int, data_dir: Path) -> subprocess.Popen:
    """Start the real backend and wait until it answers."""

    env = dict(os.environ)
    env["PANTHER_DATA_DIR"] = str(data_dir)
    env["EXTENSION_BACKEND_PORT"] = str(port)
    process = subprocess.Popen(
        [sys.executable, str(REPO / "backend" / "server.py")],
        cwd=str(REPO),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    deadline = time.time() + 30
    while time.time() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"the backend exited early:\n{process.stdout.read()}")
        try:
            status, _ = request(f"http://127.0.0.1:{port}/api/extension/health", timeout=1)
            if status == 200:
                return process
        except OSError:
            pass
        time.sleep(0.2)
    process.terminate()
    raise SystemExit("the backend never started answering")


def synthetic_capture(now: int) -> dict:
    """Build a synthetic capture payload.

    The origin, the labels and the goal are fictional. Typed values and typed
    keys are absent by construction, which is what the extension guarantees
    too.
    """

    start = now - 45_000
    return {
        "consent": True,
        "sessionId": "screenshot-demo-session",
        "extensionId": "screenshot-demo-extension",
        "startTime": start,
        "endTime": now,
        "tabId": 42,
        "url": f"{DEMO_ORIGIN}/checkout",
        "title": DEMO_TITLE,
        "goal": DEMO_GOAL,
        "screenshots": [],
        "screenshotsConsent": False,
        "events": [
            {
                "type": "navigation",
                "ts": start + 1000,
                "url": f"{DEMO_ORIGIN}/checkout",
                "target": {"tag": "a", "label": "Checkout"},
            },
            {
                "type": "click",
                "ts": start + 8000,
                "url": f"{DEMO_ORIGIN}/checkout",
                "target": {"tag": "button", "label": "Apply promo code"},
            },
            {
                "type": "change",
                "ts": start + 12000,
                "url": f"{DEMO_ORIGIN}/checkout",
                "target": {"tag": "input", "id": "promo-code", "type": "text"},
            },
            {
                "type": "click",
                "ts": start + 20000,
                "url": f"{DEMO_ORIGIN}/checkout",
                "target": {"tag": "button", "label": "Pay now"},
            },
            {
                "type": "submit",
                "ts": start + 30000,
                "url": f"{DEMO_ORIGIN}/checkout",
                "target": {"tag": "form", "id": "payment-form"},
            },
        ],
    }


def capture_page(browser: str, url: str, destination: Path, height: int = 900) -> None:
    """Photograph a real page with a real browser."""

    command = [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=2",
        "--virtual-time-budget=5000",
        f"--window-size=1000,{height}",
        f"--screenshot={destination}",
        url,
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    if not destination.exists():
        raise SystemExit(f"the browser produced no screenshot:\n{completed.stderr[-2000:]}")


def build() -> int:
    fonts = FontBook()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    browser = find_browser()

    with tempfile.TemporaryDirectory(prefix="panther-shots-") as raw:
        data_dir = Path(raw) / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        port = free_port()
        process = start_backend(port, data_dir)
        base = f"http://127.0.0.1:{port}"
        try:
            status, health_body = request(f"{base}/api/extension/health")
            if status != 200:
                raise SystemExit(f"the backend health check failed: {status}")

            now = int(time.time() * 1000)
            status, record_body = request(
                f"{base}/api/extension/record", synthetic_capture(now)
            )
            if status not in (200, 201):
                raise SystemExit(f"the backend refused the capture: {status} {record_body}")

            status, recordings_body = request(f"{base}/api/extension/recordings")
            if status != 200:
                raise SystemExit(f"the backend refused the listing: {status}")

            page = OUTPUT_DIR / "options-dashboard.png"
            capture_page(browser, f"{base}/ui/options/options.html", page, height=760)
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover - defensive
                process.kill()

    shot = session(
        "panther-intent-capture backend",
        [
            ("curl -s http://127.0.0.1:PORT/api/extension/health", health_body),
            (
                "curl -s -X POST http://127.0.0.1:PORT/api/extension/record "
                "-H 'X-Panther-Client: screenshot-capture' -d @capture.json",
                record_body,
            ),
            ("curl -s http://127.0.0.1:PORT/api/extension/recordings", recordings_body),
        ],
        fonts,
    )
    path = OUTPUT_DIR / "api.png"
    shot.save(path, optimize=True)

    for written in (page, path):
        print(f"wrote {written.relative_to(REPO)} · {written.stat().st_size // 1024} KiB")
    return 0


def main(argv: list[str] | None = None) -> int:
    return build()


if __name__ == "__main__":
    raise SystemExit(main())
