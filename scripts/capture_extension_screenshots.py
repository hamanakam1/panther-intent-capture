#!/usr/bin/env python3
"""Photograph every screen of the real Panther extension.

Every pixel in the images this script writes comes from the real product: the
real unpacked extension, the real backend started by the real native helper, and
the real pages the extension serves. Nothing is mocked, hand-drawn or
illustrated.

The capture is synthetic on purpose. The origin, the page and the ticket text
are fictional, so nothing published here identifies a real site, a real
deployment or a real person.

What it photographs:

``popup-off.png``
    The toolbar popup before anything is turned on.
``popup-consent.png``
    The popup with capture consent granted and a stated goal.
``monitor-off.png``
    The status window while Panther is off.
``monitor-capturing.png``
    The status window during a live capture.
``panel-on-page.png``
    The floating in-page panel over the captured page.
``options-recordings.png``
    The options page with the recorded capture and its draft.
``options-review.png``
    The review view of the generated draft.
``site.png``
    The documentation site.

Usage::

    python3 scripts/capture_extension_screenshots.py

The script needs a Chromium-family browser that still honours
``--load-extension`` (Chrome for Testing, Chromium, or Chrome before 137). It
registers the native helper into a temporary browser profile, so no personal
native-host registration is read or written. The backend listens on the
extension's fixed port, so that port must be free.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO / "docs" / "screenshots"

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cdp  # noqa: E402
import install_browser_helper  # noqa: E402

EXTENSION_DIR = REPO / "extension"
BACKEND_PORT = 7890

#: Browsers that still load an unpacked extension from the command line.
EXTENSION_BROWSERS = (
    "Google Chrome for Testing",
    "Chromium",
    "Microsoft Edge",
    "Google Chrome",
)


def browser_reaches_http(browser_path: str) -> bool:
    """Check that the browser can actually load an http URL.

    Some Chromium builds cannot open a loopback address in a restricted
    environment, and the failure looks like a hang rather than an error. A
    browser that cannot reach the backend cannot capture a page, so the
    script checks before it spends a capture on it.
    """
    browser = cdp.launch(browser_path)
    try:
        page = browser.new_page("about:blank")
        try:
            page.evaluate('location.href = "http://127.0.0.1:9/"', await_promise=False)
        except cdp.CDPError:
            pass
        deadline = time.time() + 8
        while time.time() < deadline:
            for target in browser.targets():
                if target.get("type") == "page" and target.get("url", "").startswith("http://"):
                    return True
            time.sleep(0.2)
        return False
    finally:
        browser.close()


def find_browser() -> str:
    """Find a Chromium-family browser that can load the unpacked extension."""
    import glob

    candidates: list[str] = []
    playwright_root = Path.home() / "Library/Caches/ms-playwright"
    candidates.extend(
        sorted(
            glob.glob(
                str(playwright_root / "chromium-*/chrome-mac*/Google Chrome for Testing.app"
                                       "/Contents/MacOS/Google Chrome for Testing")
            ),
            reverse=True,
        )
    )
    candidates.extend(
        [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
        ]
    )
    for candidate in candidates:
        path = Path(candidate)
        if not (path.is_file() and os.access(path, os.X_OK)):
            continue
        if not browser_reaches_http(candidate):
            print(f"  skip    : {path.name} cannot load an http URL in this environment")
            continue
        return str(path)
    raise SystemExit(
        "no usable Chromium-family browser found. Chrome for Testing or Chromium can load "
        "an unpacked extension; a branded Chrome newer than 136 refuses the switch."
    )


def extension_id(extension: Path) -> str:
    """The id Chrome derives from an unpacked extension's absolute path.

    Chrome hashes the absolute path, takes the first 128 bits and maps every
    nibble onto ``a``-``p``, which yields the 32 character id the browser
    shows on the extensions page.
    """
    import hashlib

    digest = hashlib.sha256(str(extension).encode()).hexdigest()[:32]
    return "".join(chr(ord("a") + int(character, 16)) for character in digest)


def port_is_free(port: int) -> bool:
    """True when nothing is listening on the loopback port."""
    import socket

    with socket.socket() as probe:
        probe.settimeout(0.4)
        return probe.connect_ex(("127.0.0.1", port)) != 0


def wait_for_backend(port: int, timeout: float = 30.0) -> bool:
    """Wait until the backend answers its health check."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/extension/health", timeout=1
            ) as response:
                if response.status == 200:
                    return True
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.25)
    return False


def synthetic_page(port: int) -> str:
    """A fictional checkout page served on the loopback interface."""
    body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Checkout - orders.example.test</title>
<style>
 body {{ font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #16202b; }}
 header {{ background: #16202b; color: #fff; padding: 18px 28px; font-weight: 700; }}
 main {{ max-width: 720px; margin: 28px auto; background: #fff; border: 1px solid #dfe3e8;
        border-radius: 10px; padding: 24px 28px; }}
 h1 {{ font-size: 22px; margin: 0 0 4px; }}
 .row {{ display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #eef1f4; }}
 .muted {{ color: #5b6673; font-size: 14px; }}
 button {{ background: #1f6feb; color: #fff; border: 0; border-radius: 7px; padding: 10px 18px; font-size: 15px; }}
 input {{ padding: 9px 11px; border: 1px solid #c9d1da; border-radius: 7px; font-size: 15px; width: 220px; }}
</style></head>
<body>
<header>orders.example.test</header>
<main>
  <h1>Checkout</h1>
  <p class="muted">A fictional page used only to demonstrate the capture panel.</p>
  <div class="row"><span>Basket</span><span>2 items &middot; 41.00</span></div>
  <div class="row"><span>Delivery</span><span>Standard &middot; 3.50</span></div>
  <div class="row"><span>Promo code</span><span><input id="promo" placeholder="Enter code" aria-label="Promo code"></span></div>
  <div class="row"><span>Total</span><span><strong>44.50</strong></span></div>
  <p><button id="apply">Apply promo code</button> <button id="pay">Pay now</button></p>
</main>
<script>
  document.getElementById("apply").addEventListener("click", () => {{}});
  document.getElementById("pay").addEventListener("click", () => {{}});
</script>
</body></html>"""
    return body


class SyntheticSite:
    """A throwaway HTTP server for the fictional checkout page."""

    def __init__(self) -> None:
        import http.server
        import threading

        page = synthetic_page(0).encode()
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - the stdlib naming
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(page)))
                self.end_headers()
                self.wfile.write(page)

            def log_message(self, *args: Any) -> None:  # noqa: ANN401 - quiet server
                return

        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def url(self, path: str = "/checkout") -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


def shoot(page: cdp.Page, name: str, *, full_page: bool = False) -> Path:
    """Write one screenshot into the published screenshot folder."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / name
    page.screenshot(str(path), full_page=full_page)
    print(f"  wrote docs/screenshots/{name} · {path.stat().st_size // 1024} KiB")
    return path


def extension_pages(browser: cdp.Browser, ext_id: str) -> dict[str, cdp.Page]:
    """Open the extension's own pages."""
    pages = {}
    for name, path in (
        ("popup", "popup/popup.html"),
        ("monitor", "monitor/monitor.html"),
        ("options", "options/options.html"),
    ):
        page = browser.new_page(f"chrome-extension://{ext_id}/{path}")
        page.wait_for("document.readyState === 'complete'", timeout=20)
        pages[name] = page
    return pages


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep-profile", action="store_true", help="keep the temporary profile")
    args = parser.parse_args(argv)

    browser_path = find_browser()
    ext_id = extension_id(EXTENSION_DIR)
    print(f"browser  : {browser_path}")
    print(f"extension: {ext_id}")

    if not port_is_free(BACKEND_PORT):
        raise SystemExit(
            f"port {BACKEND_PORT} is busy. Panther's backend uses a fixed loopback port, and the "
            "extension refuses to adopt a backend it did not start. Free the port and retry."
        )

    workdir = Path(tempfile.mkdtemp(prefix="panther-shots-"))
    profile = workdir / "profile"
    data = workdir / "data"
    profile.mkdir(parents=True)
    data.mkdir(parents=True)

    helper = install_browser_helper.install(
        install_browser_helper.plan_install(
            browser="chromium",
            extension_id=ext_id,
            data_dir=data,
            user_data_dir=profile,
        )
    )
    print(f"helper   : {helper}")

    site = SyntheticSite()
    browser = cdp.launch(
        browser_path,
        extension=str(EXTENSION_DIR),
        extra_args=(f"--user-data-dir={profile}",),
    )
    try:
        pages = extension_pages(browser, ext_id)
        popup = pages["popup"]
        monitor = pages["monitor"]
        options = pages["options"]
        popup.set_viewport(460, 940)
        monitor.set_viewport(520, 900)
        options.set_viewport(1200, 900)

        # 1. The popup before anything is turned on.
        popup.wait_for("document.getElementById('powerStatus')?.textContent?.length > 0", timeout=15)
        shoot(popup, "popup-off.png", full_page=True)

        # 2. The status window while Panther is off.
        monitor.wait_for("document.getElementById('powerStatus')?.textContent?.length > 0", timeout=15)
        shoot(monitor, "monitor-off.png", full_page=True)

        # 3. Turn Panther on through the real message path. The native helper
        #    starts the owned backend; nothing else is started or adopted.
        reply = popup.evaluate(
            "chrome.runtime.sendMessage({type: 'extension.turnOn'}).then(r => JSON.stringify(r))"
        )
        print(f"  turnOn  : {str(reply)[:200]}")
        if not wait_for_backend(BACKEND_PORT, timeout=40):
            raise SystemExit("the native helper did not bring the backend up")
        time.sleep(1.5)
        popup.evaluate("chrome.runtime.sendMessage({type: 'extension.getStatus'})")
        time.sleep(0.8)
        shoot(popup, "popup-on.png", full_page=True)
        shoot(monitor, "monitor-on.png", full_page=True)

        # 4. Capture consent and a stated goal, with the helper panel open.
        consent = popup.evaluate(
            "chrome.runtime.sendMessage({type: 'extension.setEnabled', enabled: true})"
            ".then(r => JSON.stringify(r))"
        )
        print(f"  consent : {str(consent)[:160]}")
        popup.evaluate(
            "document.getElementById('consent').checked = true;"
            "document.getElementById('goal').value ="
            " 'Applying a promo code at checkout should not discard the entered code';"
            "document.querySelector('.helper-setup').open = true;"
            "document.getElementById('extensionId').textContent = chrome.runtime.id;"
        )
        time.sleep(0.8)
        shoot(popup, "popup-consent.png", full_page=True)

        # 5. A real capture. The extension may only script the origin it was
        #    granted, so the synthetic page is tried first and the backend's
        #    own page is the fallback.
        captured = None
        for label, url in (
            ("synthetic page", site.url()),
            ("backend page", f"http://127.0.0.1:{BACKEND_PORT}/ui/options/options.html"),
        ):
            before = popup.evaluate(
                "chrome.tabs.query({}).then(tabs => tabs.map(t => ({id: t.id, windowId: t.windowId})))"
            ) or []
            target = browser.new_page("about:blank")
            target.set_viewport(1000, 800)
            # The tab is opened blank and then navigated: some browsers ignore
            # the URL passed to the DevTools endpoint.
            target.navigate(url)
            target.wait_for("document.readyState === 'complete'", timeout=15)
            # Focus the page: the extension only captures the active tab of
            # the focused window, and a tab's URL is not readable for every
            # origin, so the tab is identified by what changed.
            target.call("Page.bringToFront")
            time.sleep(0.6)
            after = popup.evaluate(
                "chrome.tabs.query({}).then(tabs => tabs.map(t => ({id: t.id, windowId: t.windowId})))"
            ) or []
            before_ids = {tab["id"] for tab in (before or [])}
            opened = [tab for tab in after if tab["id"] not in before_ids]
            if not opened:
                print("  tabs    :", after)
                target.close()
                continue
            tab = opened[-1]
            # The extension only captures the active tab of the focused window,
            # so the window is focused and the tab activated from inside the
            # extension, exactly as a person clicking the toolbar would.
            focused = popup.evaluate(
                "chrome.windows.update(%d, {focused: true})"
                ".then(() => chrome.tabs.update(%d, {active: true}))"
                ".then(() => JSON.stringify({tab: %d, window: %d}))"
                % (tab["windowId"], tab["id"], tab["id"], tab["windowId"])
            )
            print(f"  focused : {focused}")
            time.sleep(0.8)
            started = popup.evaluate(
                "chrome.runtime.sendMessage({type: 'extension.startRecording', tabId: %d, consent: true,"
                " goal: 'Applying a promo code at checkout should not discard the entered code',"
                " screenshots: false}).then(r => JSON.stringify(r))" % tab["id"]
            )
            print(f"  start ({label}): {str(started)[:220]}")
            if '"ok":true' in str(started):
                captured = (label, target)
                break
            target.close()
        if captured is None:
            raise SystemExit("the extension refused to start a capture on any permitted page")
        label, target = captured

        time.sleep(1.5)
        shoot(target, "panel-on-page.png")

        # A click on the page, so the live feed has something to show.
        target.evaluate(
            "(() => { const button = [...document.querySelectorAll('button')]"
            ".find(b => !b.disabled); if (button) button.click(); })()"
        )
        time.sleep(1.5)
        shoot(monitor, "monitor-capturing.png", full_page=True)

        # 6. Stop: the capture is saved and an evidence draft is prepared.
        stopped = popup.evaluate(
            "chrome.runtime.sendMessage({type: 'extension.stopRecording'}).then(r => JSON.stringify(r))"
        )
        print(f"  stop    : {str(stopped)[:200]}")
        time.sleep(4.0)
        shoot(monitor, "monitor-ready.png", full_page=True)

        # 7. The options page and the review view.
        options.navigate(f"chrome-extension://{ext_id}/options/options.html")
        options.wait_for("document.readyState === 'complete'", timeout=20)
        time.sleep(2.5)
        shoot(options, "options-recordings.png", full_page=True)

        # Open the generated draft in the review view.
        options.evaluate(
            "(() => { const link = [...document.querySelectorAll('button, a')]"
            ".find(node => /review/i.test(node.textContent || '')); if (link) link.click(); })()"
        )
        time.sleep(2.0)
        shoot(options, "options-review.png", full_page=True)

        # 8. The documentation site.
        site_page = browser.new_page("about:blank")
        site_page.navigate((REPO / "docs" / "index.html").as_uri())
        site_page.set_viewport(1280, 900)
        site_page.wait_for("document.readyState === 'complete'", timeout=20)
        time.sleep(0.8)
        shoot(site_page, "site.png")
        site_page.close()

        for page in pages.values():
            page.close()
    finally:
        browser.close()
        site.close()
        try:
            install_browser_helper.uninstall(
                browser="chromium",
                extension_id=ext_id,
                data_dir=data,
                user_data_dir=profile,
            )
        except (ValueError, OSError) as error:  # pragma: no cover - best effort cleanup
            print(f"  helper cleanup: {error}")
        if not args.keep_profile:
            shutil.rmtree(workdir, ignore_errors=True)
        else:
            print(f"  kept {workdir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
