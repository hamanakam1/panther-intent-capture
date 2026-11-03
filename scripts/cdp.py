"""Minimal Chrome DevTools Protocol client (standard library only).

Enough of the protocol to drive a real browser for documentation screenshots:
launch it, find a target, navigate, run JavaScript in the page, and capture a
screenshot. No third-party packages, so the script runs anywhere Python does.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from typing import Any


class CDPError(RuntimeError):
    """The browser refused a command or the connection failed."""


def free_port() -> int:
    """Ask the kernel for a port nobody is using."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@dataclass
class Browser:
    """A launched browser that exposes the DevTools protocol."""

    process: subprocess.Popen
    port: int
    user_data_dir: str

    def targets(self) -> list[dict[str, Any]]:
        """List the open targets (pages, workers) of this browser."""
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/list", timeout=5) as response:
            return json.loads(response.read().decode())

    def new_page(self, url: str = "about:blank") -> "Page":
        """Open a new tab and return a client for it.

        The tab is created through the browser-level DevTools session, which
        is the only way that reliably applies the URL: the HTTP endpoint
        creates a blank tab in some builds.
        """
        version = json.loads(
            urllib.request.urlopen(
                f"http://127.0.0.1:{self.port}/json/version", timeout=5
            ).read().decode()
        )
        browser_socket = _WebSocket(version["webSocketDebuggerUrl"])
        try:
            browser_socket.send(
                json.dumps(
                    {
                        "id": 1,
                        "method": "Target.createTarget",
                        "params": {"url": url},
                    }
                )
            )
            while True:
                message = json.loads(browser_socket.recv())
                if message.get("id") == 1:
                    target_id = message["result"]["targetId"]
                    break
        finally:
            browser_socket.close()
        for target in self.targets():
            if target.get("id") == target_id:
                return Page(self.port, target["webSocketDebuggerUrl"])
        raise CDPError(f"the browser did not report the new target {target_id}")

    def close(self) -> None:
        """Stop the browser and remove its profile."""
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:  # pragma: no cover - defensive
            self.process.kill()
        if self.user_data_dir.startswith(tempfile.gettempdir()):
            import shutil

            shutil.rmtree(self.user_data_dir, ignore_errors=True)


def launch(
    binary: str,
    *,
    extension: str | None = None,
    extra_args: tuple[str, ...] = (),
    headless: bool = True,
) -> Browser:
    """Launch a browser with the DevTools protocol and, optionally, an extension."""
    user_data_dir = tempfile.mkdtemp(prefix="panther-cdp-")
    port = free_port()
    command = [
        binary,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--hide-scrollbars",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
    ]
    if headless:
        command.append("--headless=new")
    if extension:
        command.append(f"--load-extension={extension}")
    command.extend(extra_args)
    command.append("about:blank")
    process = subprocess.Popen(
        command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    browser = Browser(process=process, port=port, user_data_dir=user_data_dir)
    deadline = time.time() + 30
    while time.time() < deadline:
        if process.poll() is not None:
            raise CDPError("the browser exited before the DevTools endpoint answered")
        try:
            browser.targets()
            return browser
        except OSError:
            time.sleep(0.2)
    browser.close()
    raise CDPError("the browser never exposed its DevTools endpoint")


class _WebSocket:
    """A tiny RFC 6455 client: text frames, masked writes, no extensions."""

    def __init__(self, url: str) -> None:
        without_scheme = url.split("://", 1)[1]
        host_port, _, path = without_scheme.partition("/")
        host, _, port = host_port.partition(":")
        self._socket = socket.create_connection((host, int(port or 80)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET /{path} HTTP/1.1\r\n"
            f"Host: {host_port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self._socket.sendall(request.encode())
        self._buffer = b""
        while b"\r\n\r\n" not in self._buffer:
            chunk = self._socket.recv(4096)
            if not chunk:
                raise CDPError("the DevTools endpoint closed during the handshake")
            self._buffer += chunk
        head, _, rest = self._buffer.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise CDPError(f"the DevTools endpoint refused the upgrade: {head[:120]!r}")
        self._buffer = rest

    def send(self, message: str) -> None:
        """Send one text frame."""
        payload = message.encode()
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 1 << 16:
            header.append(0x80 | 126)
            header.extend(struct.pack(">H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack(">Q", length))
        mask = os.urandom(4)
        header.extend(mask)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self._socket.sendall(bytes(header) + masked)

    def recv(self) -> str:
        """Read one text frame."""
        while True:
            frame = self._read_frame()
            if frame is None:
                continue
            opcode, payload = frame
            if opcode == 0x1:
                return payload.decode()
            if opcode == 0x8:
                raise CDPError("the DevTools endpoint closed the connection")
            if opcode == 0x9:  # ping -> pong
                self._send_pong(payload)

    def _send_pong(self, payload: bytes) -> None:
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self._socket.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask + masked)

    def _read_frame(self) -> tuple[int, bytes] | None:
        header = self._read_exactly(2)
        opcode = header[0] & 0x0F
        masked = bool(header[1] & 0x80)
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exactly(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exactly(8))[0]
        mask = self._read_exactly(4) if masked else b""
        payload = self._read_exactly(length) if length else b""
        if masked:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return opcode, payload

    def _read_exactly(self, count: int) -> bytes:
        while len(self._buffer) < count:
            chunk = self._socket.recv(65536)
            if not chunk:
                raise CDPError("the DevTools endpoint closed the connection")
            self._buffer += chunk
        data, self._buffer = self._buffer[:count], self._buffer[count:]
        return data

    def close(self) -> None:
        """Close the socket."""
        try:
            self._socket.close()
        except OSError:  # pragma: no cover - defensive
            pass


class Page:
    """A client for one page target."""

    def __init__(self, port: int, websocket_url: str) -> None:
        self.port = port
        self._socket = _WebSocket(websocket_url)
        self._next_id = 0

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Call one DevTools method and return its result."""
        self._next_id += 1
        message_id = self._next_id
        self._socket.send(
            json.dumps({"id": message_id, "method": method, "params": params or {}})
        )
        while True:
            message = json.loads(self._socket.recv())
            if message.get("id") == message_id:
                if "error" in message:
                    raise CDPError(f"{method} failed: {message['error']}")
                return message.get("result", {})

    def navigate(self, url: str) -> None:
        """Open a URL and wait for the load event."""
        self.call("Page.enable")
        self.call("Page.navigate", {"url": url})
        self.wait_for("document.readyState === 'complete'", timeout=20)

    def evaluate(self, expression: str, await_promise: bool = True) -> Any:
        """Run JavaScript in the page and return its value."""
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": True,
            },
        )
        if result.get("exceptionDetails"):
            detail = result["exceptionDetails"]
            text = detail.get("exception", {}).get("description") or detail.get("text")
            raise CDPError(f"the page threw: {text}")
        return result.get("result", {}).get("value")

    def wait_for(self, expression: str, timeout: float = 10.0, interval: float = 0.1) -> bool:
        """Poll a JavaScript expression until it is true."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.evaluate(expression, await_promise=False):
                    return True
            except CDPError:
                pass
            time.sleep(interval)
        return False

    def set_viewport(self, width: int, height: int, scale: float = 2.0) -> None:
        """Set the viewport size and device pixel ratio."""
        self.call(
            "Emulation.setDeviceMetricsOverride",
            {
                "width": width,
                "height": height,
                "deviceScaleFactor": scale,
                "mobile": False,
            },
        )

    def screenshot(self, path: str, *, full_page: bool = False) -> str:
        """Write a PNG of the page."""
        params: dict[str, Any] = {"format": "png", "captureBeyondViewport": full_page}
        if full_page:
            metrics = self.call("Page.getLayoutMetrics")
            size = metrics.get("cssContentSize") or metrics.get("contentSize") or {}
            params["clip"] = {
                "x": 0,
                "y": 0,
                "width": size.get("width", 800),
                "height": size.get("height", 600),
                "scale": 1,
            }
        data = self.call("Page.captureScreenshot", params)["data"]
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(data))
        return path

    def close(self) -> None:
        """Close the connection."""
        self._socket.close()
