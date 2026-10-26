#!/usr/bin/env python3
"""Standalone backend for the panther-intent-capture extension.

Stores recordings under ~/.panther-intent-capture/ and runs local inference
via Ollama (http://127.0.0.1:11434/v1). Defaults to :7890.
"""

from __future__ import annotations

import os
import sys
import argparse
import json
import threading
import uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

# allow running both as `python3 backend/server.py` and `python3 -m backend.server`
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.routes import handle_request  # noqa: E402
import automation  # noqa: E402
import integrations  # noqa: E402
from automation import start_worker, stop_worker  # noqa: E402

PORT = int(os.environ.get("EXTENSION_BACKEND_PORT", "7890"))
HOST = "127.0.0.1"


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def do_OPTIONS(self):
        handle_request(self)

    def do_GET(self):
        handle_request(self)

    def do_POST(self):
        handle_request(self)

    def do_DELETE(self):
        handle_request(self)

    def log_message(self, fmt, *args):  # quiet default
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))


def browser_owned(parent_fd, ready_fd):
    """Private inherited-pipe lifecycle; deliberately exposes no HTTP controls."""
    server = None
    stopped = threading.Event()
    serving = threading.Event()
    owned = threading.Event()
    automation._BROWSER_OWNED = True
    automation._BROWSER_SESSION = uuid.uuid4().hex
    integrations.BEFORE_POST = automation.require_browser_active

    def parent_disconnected():
        try:
            while os.read(parent_fd, 1):
                pass
        finally:
            stopped.set()
            if not owned.is_set():
                os._exit(0)  # Never revoke jobs belonging to an occupied listener.
            # Exit remains bounded even if an in-flight request holds DATA_LOCK.
            deadline = threading.Timer(20, lambda: os._exit(2))
            deadline.daemon = True
            deadline.start()
            try:
                automation.revoke_browser_work()
                if server is not None:
                    server.server_close()
                automation.cancel_unfinished_browser_work()
                if server is not None and serving.is_set():
                    server.shutdown()
            except Exception:
                print("Panther browser shutdown preserved an interrupted job for fail-closed recovery", file=sys.stderr)
                os._exit(2)
            os._exit(0)  # Daemon inference/request threads cannot outlive browser Off.

    threading.Thread(target=parent_disconnected, daemon=True, name="panther-browser-lease").start()
    try:
        # Bind before touching existing job state. An occupied port is not ours.
        server = ThreadingHTTPServer((HOST, PORT), Handler)
        owned.set()
        automation.cancel_unfinished_browser_work()
        if stopped.is_set():
            return
        start_worker()
        os.write(ready_fd, b'{"ok":true}\n')
        os.close(ready_fd)
        ready_fd = None
        serving.set()
        server.serve_forever(poll_interval=0.1)
    except Exception as exc:
        message = "Port is occupied; Panther will not adopt or stop another backend" if isinstance(exc, OSError) else "Prior automation could not be safely cancelled; backend was not started"
        if ready_fd is not None:
            os.write(ready_fd, (json.dumps({"ok": False, "error": message}) + "\n").encode())
        print(f"Panther browser startup failed: {type(exc).__name__}", file=sys.stderr)
    finally:
        if ready_fd is not None:
            os.close(ready_fd)
        if server is not None:
            server.server_close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-parent-fd", type=int)
    parser.add_argument("--native-ready-fd", type=int)
    args = parser.parse_args(argv)
    if args.native_parent_fd is not None or args.native_ready_fd is not None:
        if args.native_parent_fd is None or args.native_ready_fd is None:
            parser.error("Both inherited native descriptors are required")
        browser_owned(args.native_parent_fd, args.native_ready_fd)
        return
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("""
        ⠀⠀⠀⠀⢀⣠⣤⣤⣤⣤⣤⣤⣤⣤⣄⠀⠀⠀⠀
        ⠀⢠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡀⠀⠀
        ⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⠀⠀
        ⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀
        ⠀⣿⣿⣿    (o)   (o)    ⣿⣿⣿⠀⠀
        ⠀⣿⣿⣿        △        ⣿⣿⣿⠀⠀
        ⠀⠹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠏⠀⠀
        ⠀⠀⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠏⠀⠀⠀

   ┌─────────────────────────────────┐
   │  ▭   PANTHER INTENT CAPTURE   ✕ │
   │                                 │
   │     (panther watches browser)   │
   │                                 │
   └─────────────────────────────────┘

panther-intent-capture backend  v1.7.0   listening on http://{HOST}:{PORT}
local capture  •  explicit consent  •  reviewable drafts  •  optional unredacted screenshots
    """.format(HOST=HOST, PORT=PORT))
    start_worker()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_worker()
        server.server_close()


if __name__ == "__main__":
    main()
