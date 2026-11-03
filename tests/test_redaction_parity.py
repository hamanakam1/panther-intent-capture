"""The backend and the extension must redact the same way.

The backend re-redacts whatever a client posts, so it is defense in depth for
the extension. If the two implementations drift, a client that posts directly
to the backend can store something the extension would have removed - for
example a session identifier in a URL, which the extension redacts and the
backend used to keep.

This test runs one corpus through both implementations and requires the same
result. It needs Node to load the extension module; without Node the test
skips and the Python-side regression tests in ``test_backend.py`` still cover
the behaviour.
"""

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "backend"))

import redaction  # noqa: E402

NODE_SCRIPT = """
import { sanitizeUrl, sanitizeCaptureEvent, sanitizeText, sanitizeEventPayload }
  from "%(module)s";
const corpus = JSON.parse(process.argv[1]);
console.log(JSON.stringify({
  urls: corpus.urls.map((value) => sanitizeUrl(value)),
  events: corpus.events.map((event) => sanitizeCaptureEvent(event, event.ts)),
  texts: corpus.texts.map((value) => sanitizeText(value, 120)),
  payloads: corpus.payloads.map((value) => sanitizeEventPayload(value)),
}));
"""

CORPUS = {
    "urls": [
        "https://example.test/session/abc123",
        "https://example.test/session/abc123#session/xyz",
        "https://example.test/my-session-id/42",
        "https://example.test/sessionid/7",
        "https://example.test/session/",
        "https://example.test/a/session/b/c",
        "https://example.test/session%2Fid/5",
        "https://example.test/#session",
        "https://example.test/%73ession/9",
        "https://example.test/token/topsecret",
        "https://example.test/cookie/abc",
        "https://example.test/key/2",
        "https://example.test/pass/3",
        "https://example.test/secret/4",
        "https://example.test/auth/xyz",
        "https://example.test/credentials/1",
        "https://example.test/path#frag",
        "https://example.test/#" + "a" * 100,
        "https://example.test/#" + "a" * 99,
        "https://example.test/" + "b" * 49,
        "https://example.test/" + "b" * 48,
        "https://example.test/a/b?token=1",
        "http://user:pass@127.0.0.1:8080/?token=secret#cockpit",
        "https://example.test/x#a/b",
        "https://example.test/",
        "https://example.test/session",
        "not a url",
        "/relative/path",
        "ftp://example.test/x",
    ],
    "events": [
        {
            "type": "click",
            "ts": 1700000000000,
            "url": "https://example.test/session/abc",
            "target": {"tag": "button", "label": "Save", "role": "button", "id": "save",
                       "type": "submit", "dataTab": "t1", "dataTicket": "T-1"},
        },
        {
            "type": "change",
            "ts": 1700000000001,
            "url": "https://example.test/",
            "target": {"tag": "input", "value": "secret", "text": "secret", "label": "secret"},
        },
        {"type": "submit", "ts": 1700000000002, "url": "https://example.test/x"},
        {
            "type": "navigation",
            "ts": 1700000000003,
            "url": "https://example.test/y",
            "target": {"tag": "a", "label": "Link", "href": "https://example.test/session/z"},
        },
        {"type": "click", "ts": 1700000000004, "url": "https://example.test/",
         "target": {"tag": "button"}},
        {"type": "click", "ts": 1700000000013, "url": "https://example.test/",
         "target": {"tag": "div", "role": "button", "id": "tile", "inert": True}},
        {"type": "click", "ts": 1700000000014, "url": "https://example.test/",
         "target": {"tag": "div", "id": "tile2", "inert": "yes"}},
        {"type": "click", "ts": 1700000000005, "url": "https://example.test/",
         "target": {"tag": "a", "href": ""}},
        {"type": "click", "url": "https://example.test/"},
        {"type": "keydown", "ts": 1700000000006, "key": "password"},
        {"type": "diagnostic", "ts": 1700000000007, "url": "https://example.test/page?token=1",
         "diagnostic": {"kind": "uncaught_exception", "message": "TypeError: x is not a function",
                        "source": "https://example.test/app.js", "line": 12, "column": 3, "extra": "private"}},
        {"type": "diagnostic", "ts": 1700000000008, "url": "https://example.test/",
         "diagnostic": {"kind": "http_error", "message": "A request returned HTTP 500",
                        "source": "https://example.test/api/tickets?token=1", "status": 500}},
        {"type": "diagnostic", "ts": 1700000000009, "url": "https://example.test/",
         "diagnostic": {"kind": "http_error", "message": "no readable status"}},
        {"type": "diagnostic", "ts": 1700000000010, "url": "https://example.test/",
         "diagnostic": {"kind": "not_a_kind", "message": "unknown channel"}},
        {"type": "diagnostic", "ts": 1700000000011, "url": "https://example.test/",
         "diagnostic": {"kind": "resource_error", "message": "A img resource failed to load",
                        "source": "https://example.test/missing.png"}},
        # A failure keeps the instant it happened; both sides truncate it the
        # same way so the recorded timeline is identical.
        {"type": "diagnostic", "ts": 1700000000012.75, "url": "https://example.test/",
         "diagnostic": {"kind": "http_error", "message": "A request returned HTTP 503",
                        "source": "https://example.test/api", "status": 503}},
    ],
    "texts": [
        "Bearer abc123",
        "sk-1234567890",
        "password=hunter2",
        "person@example.test",
        "a" * 60,
        "plain text",
    ],
    "payloads": [
        {"password": "x", "token": "y", "nested": {"api_key": "z"}},
    ],
}


@unittest.skipIf(shutil.which("node") is None, "node is required to load the extension redaction")
class RedactionParityTests(unittest.TestCase):
    """One corpus, two implementations, one result."""

    @classmethod
    def setUpClass(cls):
        script = NODE_SCRIPT % {"module": REPO_ROOT / "extension" / "shared" / "redaction.js"}
        completed = subprocess.run(
            ["node", "--input-type=module", "-e", script, json.dumps(CORPUS)],
            capture_output=True,
            text=True,
            check=True,
        )
        cls.extension = json.loads(completed.stdout)

    def test_urls_redact_identically(self):
        for url, expected in zip(CORPUS["urls"], self.extension["urls"]):
            with self.subTest(url=url):
                self.assertEqual(redaction.sanitize_url(url), expected)

    def test_capture_events_redact_identically(self):
        for event, expected in zip(CORPUS["events"], self.extension["events"]):
            with self.subTest(event=event):
                actual = redaction.sanitize_capture_event(event)
                if "ts" not in event:
                    # Both stamp "now"; only the instant differs.
                    self.assertIsNotNone(actual)
                    self.assertAlmostEqual(actual["ts"], expected["ts"], delta=5000)
                    self.assertEqual({k: v for k, v in actual.items() if k != "ts"},
                                     {k: v for k, v in expected.items() if k != "ts"})
                    continue
                self.assertEqual(actual, expected)

    def test_texts_redact_identically(self):
        for text, expected in zip(CORPUS["texts"], self.extension["texts"]):
            with self.subTest(text=text):
                self.assertEqual(redaction.sanitize_text(text, 120), expected)

    def test_payloads_redact_identically(self):
        for payload, expected in zip(CORPUS["payloads"], self.extension["payloads"]):
            with self.subTest(payload=payload):
                self.assertEqual(redaction.sanitize_event_payload(payload), expected)

    def test_a_session_identifier_never_survives_a_url(self):
        for url in ("https://example.test/session/abc123",
                    "https://example.test/my-session-id/42",
                    "https://example.test/#session"):
            with self.subTest(url=url):
                self.assertNotIn("abc123", redaction.sanitize_url(url))
                self.assertNotIn("42", redaction.sanitize_url(url))
                self.assertNotIn("#session", redaction.sanitize_url(url))

    def test_page_text_is_never_read_from_a_text_field(self):
        """The extension sends an accessible name as "label" and never page text."""
        event = {"type": "click", "ts": 1, "target": {"tag": "button", "text": "private page text"}}
        clean = redaction.sanitize_capture_event(event)
        self.assertEqual(clean["target"], {"tag": "button"})

    def test_an_event_always_carries_a_timestamp(self):
        clean = redaction.sanitize_capture_event({"type": "click", "url": "https://example.test/"})
        self.assertIsInstance(clean["ts"], int)
        self.assertGreater(clean["ts"], 0)
        for invalid in (None, "later", float("nan"), float("inf"), True):
            with self.subTest(invalid=invalid):
                stamped = redaction.sanitize_capture_event(
                    {"type": "click", "ts": invalid, "url": "https://example.test/"}
                )
                self.assertIsInstance(stamped["ts"], int)
                self.assertGreater(stamped["ts"], 0)


if __name__ == "__main__":
    unittest.main()
