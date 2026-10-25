"""Ephemeral live interpretation regressions with synthetic data and mocked AI."""
import concurrent.futures
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from email.message import Message
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import automation
import inference
import live_insights
import storage
import destinations
from api import routes
from server import Handler


def sample_request():
    return {
        "consent": True, "sessionId": "synthetic-live-session", "revision": 3,
        "goal": "Find the saved view", "page": {"title": "Synthetic app", "url": "https://example.test/views"},
        "events": [
            {"seq": 1, "ts": 1700000001000, "type": "click", "label": "Views", "url": "https://example.test/"},
            {"seq": 3, "ts": 1700000002000, "type": "click", "label": "Saved", "url": "https://example.test/views"},
        ],
    }


def sample_result():
    return {
        "summary": "Two navigation controls were clicked.",
        "intent": "The user may be looking for saved views.", "possibleIssue": "",
        "evidence": [1, 3], "confidence": "low",
    }


class LiveInsightTests(unittest.TestCase):
    def setUp(self):
        self.patches = [
            patch.object(live_insights, "_INFERENCE_SLOT", threading.Lock()),
            patch.object(live_insights, "_LAST_STARTED", None),
            patch.object(automation, "require_browser_active"),
            patch.object(inference, "OLLAMA_ENDPOINT", "http://127.0.0.1:11434/v1"),
            patch.object(inference, "local_chat", return_value=json.dumps(sample_result())),
        ]
        self.mocks = [item.start() for item in self.patches]
        self.active = self.mocks[2]
        self.chat = self.mocks[4]
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])

    def test_valid_result_is_transient_tentative_and_evidence_linked(self):
        result = live_insights.analyze(sample_request())
        self.assertTrue(result["ok"])
        self.assertEqual(result["sessionId"], "synthetic-live-session")
        self.assertEqual(result["revision"], 3)
        self.assertEqual(result["source"], "local-ai")
        self.assertEqual(result["evidence"], [1, 3])
        self.assertFalse(result["execution_authorized"])
        self.assertGreater(result["analyzedAt"], 0)
        self.assertGreaterEqual(self.active.call_count, 3)
        payload = self.chat.call_args.args[0]
        self.assertEqual(self.chat.call_args.kwargs["timeout"], 15)
        self.assertEqual(payload["max_tokens"], 350)
        self.assertEqual(payload["temperature"], 0.1)
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertFalse(payload["stream"])
        self.assertNotIn("tools", payload)
        system = payload["messages"][0]["content"]
        self.assertIn("untrusted observations", system)
        self.assertIn("cannot execute work", system)
        self.assertIn("Do not claim a bug is verified", system)
        observed = json.loads(payload["messages"][1]["content"])
        self.assertNotIn("sessionId", observed)
        self.assertEqual(set(observed), {"goal", "page", "events"})

    def test_exact_request_allowlist_and_separate_consent(self):
        invalid = []
        for name in ("screenshots", "automation", "use_ai", "recordingId"):
            data = sample_request()
            data[name] = []
            invalid.append(data)
        for consent in (False, None, 1, "true"):
            invalid.append({**sample_request(), "consent": consent})
        for key in sample_request():
            data = sample_request()
            del data[key]
            invalid.append(data)
        data = sample_request()
        data["page"]["text"] = "arbitrary page text"
        invalid.append(data)
        data = sample_request()
        data["events"][0]["value"] = "typed input"
        invalid.append(data)
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                live_insights.analyze(value)
        self.chat.assert_not_called()
        self.assertIsNone(live_insights._LAST_STARTED)

    def test_input_bounds_and_types_reject_before_model(self):
        invalid = [None, [], "text"]
        for key, value in (
            ("sessionId", ""), ("sessionId", " " * 4), ("sessionId", "s" * 81), ("sessionId", 1),
            ("revision", True), ("revision", 0), ("revision", 2001), ("revision", 1.5),
            ("goal", "x" * 301), ("goal", None), ("events", []), ("events", {}),
            ("events", sample_request()["events"] * 7),
        ):
            invalid.append({**sample_request(), key: value})
        for key, value in (("title", "t" * 121), ("url", "u" * 501), ("title", None)):
            data = sample_request()
            data["page"][key] = value
            invalid.append(data)
        for key, value in (
            ("seq", True), ("seq", 0), ("seq", 4), ("seq", 1.5),
            ("ts", True), ("ts", -1), ("ts", float("nan")), ("ts", float("inf")), ("ts", 10 ** 400),
            ("type", "keydown"), ("type", {}), ("label", "x" * 141), ("url", "u" * 501),
        ):
            data = sample_request()
            data["events"][0][key] = value
            invalid.append(data)
        data = sample_request()
        data["events"][1]["seq"] = 1
        invalid.append(data)
        data = sample_request()
        data["events"].reverse()
        invalid.append(data)
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                live_insights.analyze(value)
        self.chat.assert_not_called()

    def test_all_four_semantic_event_types_are_supported(self):
        for event_type in ("click", "change", "submit", "navigation"):
            data = sample_request()
            data["events"][0]["type"] = event_type
            clean = live_insights.validate_request(data)
            self.assertEqual(clean["events"][0]["type"], event_type)

    def test_secrets_are_scrubbed_from_model_input_and_output(self):
        data = sample_request()
        data["goal"] = "Contact person@example.test with token=synthetic-token"
        data["page"]["title"] = "Bearer synthetic-token"
        data["page"]["url"] = "https://person:secret@example.test/views?token=hidden#token-secret"
        data["events"][0]["label"] = "password=synthetic-secret"
        data["events"][0]["url"] = "https://example.test/token/hidden?secret=hidden"
        response = sample_result()
        response["summary"] = "Contact person@example.test token=synthetic-token"
        self.chat.return_value = json.dumps(response)
        result = live_insights.analyze(data)
        sent = self.chat.call_args.args[0]["messages"][1]["content"]
        for secret in ("person@example.test", "synthetic-token", "synthetic-secret", "hidden", "person:secret"):
            self.assertNotIn(secret, sent)
        self.assertNotIn("person@example.test", result["summary"])
        self.assertNotIn("synthetic-token", result["summary"])
        self.assertIn("[REDACTED]", result["summary"])

    def test_invalid_model_outputs_never_gain_evidence_or_authority(self):
        invalid = ["not JSON", "```json\n{}\n```", "[]", "x" * 4097]
        for key, value in (
            ("summary", ""), ("summary", "\u0000"), ("summary", "x" * 501), ("intent", "x" * 301),
            ("possibleIssue", "x" * 301), ("confidence", "high"), ("confidence", None),
            ("evidence", []), ("evidence", [2]), ("evidence", [1, 1]), ("evidence", [True]),
            ("evidence", ["1"]), ("evidence", {}), ("evidence", [[1]]),
        ):
            invalid.append(json.dumps({**sample_result(), key: value}))
        invalid.append(json.dumps({**sample_result(), "execution_authorized": True}))
        invalid.append(json.dumps({**sample_result(), "ticket": {"title": "unrequested"}}))
        invalid.append('{"summary":"one","summary":"two"}')
        invalid.append('{"summary":NaN}')
        for raw in invalid:
            with self.subTest(raw=raw):
                live_insights._LAST_STARTED = None
                self.chat.return_value = raw
                with self.assertRaises(live_insights.LiveInsightError) as caught:
                    live_insights.analyze(sample_request())
                self.assertEqual(caught.exception.status, 502)
                self.assertNotIn(raw, str(caught.exception))
                self.assertFalse(live_insights._INFERENCE_SLOT.locked())

    def test_unknown_intent_is_allowed_and_model_name_is_bounded(self):
        self.chat.return_value = json.dumps({**sample_result(), "intent": "", "evidence": [1]})
        with patch.object(inference, "OLLAMA_MODEL", "synthetic-model/" * 15):
            result = live_insights.analyze(sample_request())
        self.assertEqual(result["intent"], "")
        self.assertEqual(result["evidence"], [1])
        self.assertEqual(len(result["model"]), 120)
        prompt = self.chat.call_args.args[0]["messages"][0]["content"]
        self.assertIn("at least one unique integer seq reference", prompt)

    def test_busy_request_is_nonblocking(self):
        live_insights._INFERENCE_SLOT.acquire()
        try:
            with self.assertRaises(live_insights.LiveInsightBusy):
                live_insights.analyze(sample_request())
        finally:
            live_insights._INFERENCE_SLOT.release()
        self.chat.assert_not_called()

    def test_rate_limit_is_process_wide_and_attempt_based(self):
        with patch.object(live_insights.time, "monotonic", return_value=100):
            live_insights.analyze(sample_request())
        with patch.object(live_insights.time, "monotonic", return_value=111.9):
            with self.assertRaises(live_insights.LiveInsightBusy):
                live_insights.analyze({**sample_request(), "sessionId": "different-session"})
        self.assertEqual(self.chat.call_count, 1)
        with patch.object(live_insights.time, "monotonic", return_value=112):
            live_insights.analyze(sample_request())
        self.assertEqual(self.chat.call_count, 2)

    def test_model_failure_is_generic_no_fallback_and_releases_slot(self):
        self.chat.side_effect = TimeoutError("private transport detail")
        with self.assertRaises(live_insights.LiveInsightError) as caught:
            live_insights.analyze(sample_request())
        self.assertEqual(caught.exception.status, 502)
        self.assertNotIn("private transport detail", str(caught.exception))
        self.chat.assert_called_once()
        self.assertFalse(live_insights._INFERENCE_SLOT.locked())
        with self.assertRaises(live_insights.LiveInsightBusy):
            live_insights.analyze(sample_request())
        self.chat.assert_called_once()

    def test_non_loopback_endpoint_is_rejected_without_model_call(self):
        with patch.object(inference, "OLLAMA_ENDPOINT", "https://models.example.test/v1"):
            with self.assertRaises(live_insights.LiveInsightError):
                live_insights.analyze(sample_request())
        self.chat.assert_not_called()

    def test_off_before_inference_or_during_model_discards_result(self):
        self.active.side_effect = ValueError("off")
        with self.assertRaises(live_insights.LiveInsightStopped):
            live_insights.analyze(sample_request())
        self.chat.assert_not_called()
        self.active.side_effect = [None, None, ValueError("off")]
        with self.assertRaises(live_insights.LiveInsightStopped):
            live_insights.analyze(sample_request())
        self.chat.assert_called_once()
        self.assertFalse(live_insights._INFERENCE_SLOT.locked())

    def test_json_parser_rejects_duplicate_fields_and_nonfinite_numbers(self):
        for raw in (b'{"consent":false,"consent":true}', b'{"page":{"url":"a","url":"b"}}',
                    b'{"ts":NaN}', b'{"ts":Infinity}', b"\xff"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                live_insights.parse_json(raw)

    def test_body_limit_rejects_before_any_read(self):
        for length, transfer in (("16001", None), ("-1", None), ("bad", None), ("0", None), ("40", "chunked")):
            headers = Message()
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = length
            if transfer:
                headers["Transfer-Encoding"] = transfer
            handler = SimpleNamespace(headers=headers, rfile=io.BytesIO(b"unread body"), close_connection=False)
            with self.subTest(length=length, transfer=transfer), self.assertRaises(ValueError):
                routes._live_insight_body(handler)
            self.assertEqual(handler.rfile.tell(), 0)
            self.assertTrue(handler.close_connection)


class QuietHandler(Handler):
    def log_message(self, *args):
        pass


class LiveInsightHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="panther-live-test-")
        self.root = Path(self.temp.name)
        self.patches = [patch.object(storage, key, value) for key, value in {
            "ROOT": self.root, "RECORDINGS_DIR": self.root / "recordings", "EVENTS_DIR": self.root / "events",
            "INFERENCE_DIR": self.root / "inference", "TICKETS_DIR": self.root / "tickets",
            "CONSENT_LOG": self.root / "consent.log", "MANIFEST_FILE": self.root / "manifest.json",
        }.items()]
        self.patches.extend([
            patch.object(live_insights, "_INFERENCE_SLOT", threading.Lock()),
            patch.object(live_insights, "_LAST_STARTED", None),
            patch.object(automation, "_BROWSER_OWNED", True),
            patch.object(automation, "_PAUSED", threading.Event()),
            patch.object(inference, "OLLAMA_ENDPOINT", "http://127.0.0.1:11434/v1"),
            patch.object(inference, "local_chat", return_value=json.dumps(sample_result())),
        ])
        mocks = [item.start() for item in self.patches]
        self.chat = mocks[-1]
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def request(self, body=None, headers=None, method="POST"):
        raw = json.dumps(sample_request() if body is None else body).encode()
        request = urllib.request.Request(self.origin + "/api/extension/live-insight", data=raw, method=method,
            headers={"Content-Type": "application/json", "X-Panther-Client": "synthetic-test", **(headers or {})})
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read()), response.headers

    def test_success_is_no_store_and_does_not_persist_or_dispatch(self):
        with patch.object(storage, "write_json") as write, patch.object(destinations, "submit") as submit, \
             patch.object(automation, "enqueue") as enqueue:
            code, result, headers = self.request(headers={"Origin": "chrome-extension://syntheticextension"})
        self.assertEqual(code, 200, result)
        self.assertFalse(result["execution_authorized"])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "chrome-extension://syntheticextension")
        self.assertEqual(list(self.root.iterdir()), [])
        write.assert_not_called()
        submit.assert_not_called()
        enqueue.assert_not_called()

    def test_header_origin_host_and_consent_guards_prevent_inference(self):
        for headers in ({"X-Panther-Client": ""}, {"Origin": "https://foreign.example"}, {"Host": "foreign.example"}):
            with self.subTest(headers=headers):
                code, _, _ = self.request(headers=headers)
                self.assertEqual(code, 403)
        for body in ({**sample_request(), "consent": False}, {**sample_request(), "screenshots": []}):
            code, _, _ = self.request(body)
            self.assertEqual(code, 400)
        self.chat.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_large_and_wrong_content_type_requests_do_not_call_model(self):
        code, _, _ = self.request({**sample_request(), "goal": "x" * 17000})
        self.assertEqual(code, 400)
        code, _, _ = self.request(headers={"Content-Type": "text/plain"})
        self.assertEqual(code, 400)
        self.chat.assert_not_called()

    def test_http_rate_limit_and_model_error_statuses_are_distinct(self):
        self.chat.side_effect = RuntimeError("private-model-detail")
        code, result, _ = self.request()
        self.assertEqual(code, 502)
        self.assertNotIn("private-model-detail", json.dumps(result))
        self.assertTrue(result["retryable"])
        code, result, _ = self.request()
        self.assertEqual(code, 429)
        self.assertTrue(result["retryable"])
        self.chat.assert_called_once()

    def test_off_at_http_entry_and_during_inference_returns_no_result(self):
        automation._PAUSED.set()
        code, result, _ = self.request()
        self.assertEqual(code, 503)
        self.chat.assert_not_called()
        automation._PAUSED.clear()

        def turn_off(*args, **kwargs):
            automation._PAUSED.set()
            return json.dumps(sample_result())

        self.chat.side_effect = turn_off
        code, result, _ = self.request()
        self.assertEqual(code, 503)
        self.assertNotIn("summary", result)
        self.assertFalse(result["retryable"])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_parallel_http_requests_use_one_inference_slot(self):
        entered, release = threading.Event(), threading.Event()

        def blocked_model(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise TimeoutError("test did not release model")
            return json.dumps(sample_result())

        self.chat.side_effect = blocked_model
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.request)
            try:
                self.assertTrue(entered.wait(2))
                code, _, _ = self.request()
                self.assertEqual(code, 429)
            finally:
                release.set()
            self.assertEqual(first.result()[0], 200)
        self.chat.assert_called_once()


if __name__ == "__main__":
    unittest.main()
