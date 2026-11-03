#!/usr/bin/env python3
"""Render the architecture diagrams and export them as PNGs for the README.

The typed specifications live in ``docs/diagrams/*.json``. This script hands
each one to Archify, keeps the rendered HTML next to the specification, and
rasterises the diagram itself into a PNG that GitHub can display.

Usage::

    python3 scripts/render_diagram_pngs.py

It needs the Archify CLI and a Chromium-family browser. When Archify is not
installed the script says so and leaves the committed PNGs alone.
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
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DIAGRAMS = REPO / "docs" / "diagrams"

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cdp  # noqa: E402

ARCHIFY_CANDIDATES = (
    Path.home() / ".agents" / "skills" / "archify" / "bin" / "archify.mjs",
    Path.home() / ".claude" / "skills" / "archify" / "bin" / "archify.mjs",
    Path.home() / ".Codex" / "skills" / "archify" / "bin" / "archify.mjs",
)

BROWSERS = (
    "~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/chromium",
)


def find_archify() -> Path | None:
    """Locate the Archify CLI."""
    override = os.environ.get("ARCHIFY_BIN")
    if override and Path(override).is_file():
        return Path(override)
    for candidate in ARCHIFY_CANDIDATES:
        if candidate.is_file():
            return candidate
    return None


def find_browser() -> str | None:
    """Locate a browser that can rasterise the diagram."""
    import glob

    for pattern in BROWSERS:
        for candidate in sorted(glob.glob(os.path.expanduser(pattern)), reverse=True):
            path = Path(candidate)
            if path.is_file() and os.access(path, os.X_OK):
                return str(path)
    return None


def deliver(archify: Path, diagram_type: str, spec: Path, output: Path) -> None:
    """Render one specification to HTML."""
    command = [
        "node",
        str(archify),
        "deliver",
        diagram_type,
        str(spec),
        str(output),
        "--quality",
        "showcase",
        "--json",
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        raise SystemExit(f"Archify failed for {spec.name}:\n{completed.stderr[-1500:]}")
    receipt = json.loads(completed.stdout)
    validation = receipt.get("validation", {})
    if validation.get("checksPassed") != 9:
        raise SystemExit(f"Archify did not pass every showcase check for {spec.name}")


def rasterise(browser_path: str, html: Path, png: Path) -> None:
    """Photograph the diagram itself, without the viewer chrome."""
    browser = cdp.launch(browser_path, headless=True)
    try:
        page = browser.new_page(html.as_uri())
        page.set_viewport(1600, 1000, scale=2)
        page.wait_for("document.readyState === 'complete'", timeout=30)
        page.wait_for("!!document.querySelector('svg')", timeout=30)
        time.sleep(1.0)
        # Hide the viewer chrome so only the diagram is photographed.
        page.evaluate(
            "(() => { const style = document.createElement('style');"
            " style.textContent = 'body * { visibility: hidden !important; }'"
            " + ' body svg, body svg * { visibility: visible !important; }';"
            " document.head.appendChild(style); })()"
        )
        time.sleep(0.5)
        box = page.evaluate(
            "(() => { const svg = document.querySelector('svg');"
            " const rect = svg.getBoundingClientRect();"
            " return {x: rect.x + window.scrollX, y: rect.y + window.scrollY,"
            " width: rect.width, height: rect.height}; })()"
        )
        width = int(box["width"]) or 1600
        height = int(box["height"]) or 900
        import base64

        # Photograph the diagram only, without the viewer chrome around it.
        data = page.call(
            "Page.captureScreenshot",
            {
                "format": "png",
                "captureBeyondViewport": True,
                "clip": {
                    "x": box["x"],
                    "y": box["y"],
                    "width": width,
                    "height": height,
                    "scale": 1,
                },
            },
        )["data"]
        png.write_bytes(base64.b64decode(data))
        page.close()
    finally:
        browser.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", default=None, help="render one specification by name")
    args = parser.parse_args(argv)

    archify = find_archify()
    if archify is None:
        raise SystemExit("the Archify CLI was not found; set ARCHIFY_BIN to its path")
    browser_path = find_browser()
    if browser_path is None:
        raise SystemExit("no Chromium-family browser was found to rasterise the diagrams")

    specs = sorted(spec for spec in DIAGRAMS.glob("*.json")
                   if not spec.name.endswith(".delivery.json"))
    if args.only:
        specs = [spec for spec in specs if args.only in spec.stem]
    for spec in specs:
        diagram_type = json.loads(spec.read_text(encoding="utf-8"))["diagram_type"]
        html = DIAGRAMS / f"{spec.stem}.html"
        png = DIAGRAMS / f"{spec.stem}.png"
        print(f"rendering {spec.name} as {diagram_type}")
        deliver(archify, diagram_type, spec, html)
        rasterise(browser_path, html, png)
        print(f"  wrote {png.relative_to(REPO)} · {png.stat().st_size // 1024} KiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
