"""Real HTTP tests with an isolated store and no live dashboard/model calls."""
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
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import storage
import automation
import integrations
import destinations
from api import routes
from server import Handler
from tickets import DraftGenerationError


class QuietHandler(Handler):
    def log_message(self, *args):
        pass


class HttpTests(unittest.TestCase):
    def setUp(self):
        automation._CANCELLED.clear()
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.patches = [patch.object(storage, key, value) for key, value in {
            "ROOT": root, "RECORDINGS_DIR": root / "recordings", "EVENTS_DIR": root / "events",
            "INFERENCE_DIR": root / "inference", "TICKETS_DIR": root / "tickets",
            "CONSENT_LOG": root / "consent.log", "MANIFEST_FILE": root / "manifest.json",
        }.items()]
        for item in self.patches:
            item.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.capture = {"sessionId": "test-capture-123", "extensionId": "test-extension", "consent": True,
                        "tabId": 1, "startTime": 1700000000000, "endTime": 1700000005000,
                        "url": "http://127.0.0.1:8080/?token=secret#cockpit", "title": "Synthetic dashboard",
                        "goal": "Keep the selected tab after refreshing",
                        "events": [{"type": "click", "ts": 1700000001000, "target": {"tag": "BUTTON", "text": "Cockpit"}}]}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()
        automation._CANCELLED.clear()

    def request(self, path, body=None, method=None, headers=None):
        req = urllib.request.Request(self.origin + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method or ("POST" if body is not None else "GET"),
            headers={"Content-Type": "application/json", "X-Panther-Client": "test", **(headers or {})})
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            value = json.loads(raw) if response.headers.get_content_type() == "application/json" else raw
            return response.status, value, response.headers

    def record(self):
        code, data, _ = self.request("/api/extension/record", self.capture)
        self.assertEqual(code, 201, data)
        return data["id"]

    def test_capture_draft_edit_export_flow(self):
        rid = self.record()
        code, replay, _ = self.request("/api/extension/record", self.capture)
        self.assertEqual(code, 200)
        self.assertEqual(replay["id"], rid)
        code, record, _ = self.request(f"/api/extension/recordings/{rid}")
        self.assertEqual(record["duration_ms"], 5000)
        self.assertNotIn("secret", json.dumps(record))
        self.assertNotIn("events_path", record)
        code, drafts, _ = self.request(f"/api/extension/tickets/{rid}", {"use_ai": False})
        self.assertEqual(code, 200, drafts)
        self.assertEqual(drafts["mode"], "observed")
        ticket = drafts["tickets"][0]
        body = {"ticket_id": ticket["id"], "patch": {"title": "Preserve selected tab", "acceptance_criteria": ["Refresh keeps Cockpit selected"]}}
        code, saved, _ = self.request(f"/api/extension/tickets/{rid}/review", body)
        self.assertEqual(code, 200, saved)
        code, exported, _ = self.request(f"/api/extension/export/{rid}")
        self.assertEqual(exported["tickets"][0]["title"], "Preserve selected tab")
        self.assertFalse(exported["authority"]["execution_authorized"])
        with patch.object(destinations, "submit") as submit, patch.dict("os.environ", {"PANTHER_DASHBOARD_URL": "http://127.0.0.1:8080"}):
            code, preview, _ = self.request(f"/api/extension/integrations/ticket-service/preview/{rid}", body)
            self.assertEqual(code, 200, preview)
            self.assertIn("no-auto", preview["payload"]["tags"])
            code, denied, _ = self.request(f"/api/extension/integrations/ticket-service/submit/{rid}", body)
            self.assertEqual(code, 409)
            submit.assert_not_called()
            submit.return_value = {"ok": True, "state": "delivered", "verified": True}
            code, delivered, _ = self.request(f"/api/extension/integrations/ticket-service/submit/{rid}", {
                **body, "confirmed": True, "payload_hash": preview["payload_hash"]})
            self.assertEqual(code, 200, delivered)
            submit.assert_called_once()

    def test_page_reported_failures_are_readable_and_never_verified(self):
        capture = {**self.capture, "events": [
            {"type": "click", "ts": 1700000001000, "target": {"tag": "button", "label": "Save"}},
            {"type": "diagnostic", "ts": 1700000001200, "url": "http://127.0.0.1:8080/page",
             "diagnostic": {"kind": "http_error", "message": "A request returned HTTP 500",
                            "source": "http://127.0.0.1:8080/api/tickets?token=secret", "status": 500}},
            {"type": "diagnostic", "ts": 1700000001300, "url": "http://127.0.0.1:8080/page",
             "diagnostic": {"kind": "uncaught_exception", "message": "TypeError: x is not a function",
                            "source": "http://127.0.0.1:8080/app.js", "line": 12}},
        ]}
        code, receipt, _ = self.request("/api/extension/record", capture)
        self.assertEqual(code, 201, receipt)
        rid = receipt["id"]
        code, record, _ = self.request(f"/api/extension/recordings/{rid}")
        self.assertEqual(record["diagnostic_count"], 2)
        code, report, _ = self.request(f"/api/extension/recordings/{rid}/diagnostics")
        self.assertEqual(code, 200, report)
        self.assertEqual(report["count"], 2)
        self.assertEqual(report["kinds"], {"http_error": 1, "uncaught_exception": 1})
        self.assertIn("HTTP 500", report["failures"][0]["summary"])
        self.assertIn("not verified defects", report["interpretation"])
        self.assertNotIn("secret", json.dumps(report))
        code, drafts, _ = self.request(f"/api/extension/tickets/{rid}", {"use_ai": False})
        self.assertEqual(code, 200, drafts)
        draft = drafts["tickets"][0]
        self.assertEqual(len(draft["diagnostics"]), 2)
        self.assertIn("Page-reported failures", draft["description"])
        self.assertNotIn("secret", json.dumps(draft))

    def test_the_replay_plan_describes_the_path_and_never_authorizes_execution(self):
        rid = self.record()
        code, plan, _ = self.request(f"/api/extension/recordings/{rid}/replay")
        self.assertEqual(code, 200, plan)
        self.assertEqual(plan["schema_version"], "1.0")
        self.assertEqual(plan["authority"], {"export_only": True, "requires_review": True, "execution_authorized": False})
        self.assertFalse(plan["limits"]["values_captured"])
        self.assertFalse(plan["limits"]["executed_by_producer"])
        self.assertNotIn("secret", json.dumps(plan))
        code, script, _ = self.request(f"/api/extension/recordings/{rid}/replay?format=playwright")
        self.assertEqual(code, 200)
        self.assertIn(b"Panther never runs it", script)
        self.assertNotIn(b"secret", script)

    def test_the_destination_catalogue_lists_every_destination(self):
        code, catalogue, _ = self.request("/api/extension/integrations")
        self.assertEqual(code, 200, catalogue)
        kinds = [entry["kind"] for entry in catalogue["destinations"]]
        self.assertIn("ticket-service", kinds)
        self.assertIn("github", kinds)
        for entry in catalogue["destinations"]:
            self.assertIn("configured", entry)
            self.assertNotIn("token", json.dumps(entry).lower())

    def test_an_unknown_destination_is_refused_before_any_request(self):
        code, _, _ = self.request("/api/extension/integrations/not-a-destination")
        self.assertEqual(code, 404)
        rid = self.record()
        code, _, _ = self.request(f"/api/extension/integrations/not-a-destination/preview/{rid}", {"ticket_id": "x"})
        self.assertEqual(code, 404)

    def test_parallel_uploads_share_one_receipt(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.request("/api/extension/record", self.capture), range(4)))
        self.assertEqual(len({data["id"] for _, data, _ in results}), 1)
        self.assertEqual(sorted(code for code, _, _ in results), [200, 200, 200, 201])
        self.assertEqual(len(storage.list_recordings()), 1)

    def test_health_advertises_the_capabilities_and_the_export_contract_version(self):
        code, health, _ = self.request("/api/extension/health")
        self.assertEqual(code, 200)
        self.assertEqual(health["status"], "ok")
        self.assertIn("diagnostics", health["capabilities"])
        self.assertEqual(health["bundle_schema_version"], integrations.SCHEMA_VERSION)
        self.assertRegex(health["schema_version"], r"^\d+\.\d+$")

    def test_consent_and_malformed_inputs_are_rejected(self):
        for changes in ({"consent": False}, {"events": {}}, {"sessionId": ""}, {"startTime": -1},
                        {"endTime": float("nan")}, {"screenshots": [{"dataUrl": "data:image/jpeg;base64,ZmFrZQ=="}]}):
            with self.subTest(changes=changes):
                code, _, _ = self.request("/api/extension/record", {**self.capture, **changes})
                self.assertEqual(code, 400)
        self.assertEqual(storage.list_recordings(), [])

    def test_foreign_origin_host_and_missing_client_header_fail_closed(self):
        code, _, headers = self.request("/api/extension/recordings", headers={"Origin": "https://evil.example"})
        self.assertEqual(code, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        code, _, _ = self.request("/api/extension/health", headers={"Host": "evil.example"})
        self.assertEqual(code, 403)
        code, _, _ = self.request("/api/extension/record", self.capture, headers={"X-Panther-Client": ""})
        self.assertEqual(code, 403)

    def test_malformed_origin_is_denied_without_crashing_response(self):
        for origin in ("http://localhost:bad", "http://[broken", "http://user:pass@localhost:7890"):
            with self.subTest(origin=origin):
                code, result, headers = self.request("/api/extension/health", headers={"Origin": origin})
                self.assertEqual(code, 403)
                self.assertEqual(result["error"], "Origin not permitted")
                self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_extension_preflight_and_static_csp(self):
        extension = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
        code, _, headers = self.request("/api/extension/record", method="OPTIONS", headers={"Origin": extension})
        self.assertEqual(code, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], extension)
        code, html, headers = self.request("/ui/options/options.html")
        self.assertEqual(code, 200)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertNotIn(b"onclick=", html)
        code, script, _ = self.request("/ui/options/automation-state.js")
        self.assertEqual(code, 200)
        self.assertIn(b"export", script)
        code, _, _ = self.request("/ui/../../backend/server.py")
        self.assertEqual(code, 404)

    def test_ai_failure_does_not_destroy_evidence_draft(self):
        rid = self.record()
        _, observed, _ = self.request(f"/api/extension/tickets/{rid}", {"use_ai": False})
        with patch.object(routes, "generate_drafts", side_effect=DraftGenerationError("Local AI unavailable")):
            code, result, _ = self.request(f"/api/extension/tickets/{rid}", {"use_ai": True})
        self.assertEqual(code, 502)
        self.assertTrue(result["retryable"])
        _, saved, _ = self.request(f"/api/extension/tickets/{rid}")
        self.assertEqual(saved["tickets"], observed["tickets"])

    def test_switching_generation_modes_preserves_saved_review(self):
        rid = self.record()
        _, observed, _ = self.request(f"/api/extension/tickets/{rid}", {"use_ai": False})
        ticket_id = observed["tickets"][0]["id"]
        code, _, _ = self.request(f"/api/extension/tickets/{rid}/review", {
            "ticket_id": ticket_id, "patch": {"title": "My reviewed title", "acceptance_criteria": ["My expected result"]}})
        self.assertEqual(code, 200)
        with patch("tickets._ollama_decompose", return_value='[{"title":"AI suggestion"}]'):
            code, ai, _ = self.request(f"/api/extension/tickets/{rid}", {"use_ai": True})
        self.assertEqual(code, 200, ai)
        self.assertEqual(ai["mode"], "ai")
        code, restored, _ = self.request(f"/api/extension/tickets/{rid}", {"use_ai": False})
        self.assertEqual(code, 200)
        self.assertTrue(restored["cached"])
        self.assertEqual(restored["tickets"][0]["title"], "My reviewed title")
        self.assertEqual(restored["tickets"][0]["acceptance_criteria"], ["My expected result"])

    def test_direct_client_cannot_persist_input_values_or_typed_keys(self):
        self.capture["events"] = [
            {"type": "change", "ts": 1700000001000, "key": "private-key", "value": "private-value",
             "page": {"text": "private-page"}, "target": {"tag": "input", "value": "private-value", "text": "private-value"}},
            {"type": "keydown", "key": "private-key"},
            {"type": "click", "target": {"tag": "button", "label": "Save", "dataTab": "cockpit", "href": "https://example.test/token/private-token"}},
        ]
        rid = self.record()
        _, events, _ = self.request(f"/api/extension/recordings/{rid}/events")
        self.assertEqual(len(events["events"]), 2)
        self.assertNotIn("private", json.dumps(events))
        self.assertEqual(events["events"][1]["target"]["label"], "Save")
        self.assertEqual(events["events"][1]["target"]["dataTab"], "cockpit")
        stored = Path(storage.get_recording(rid)["events_path"]).read_text()
        self.assertNotIn("private", stored)

    def test_screenshot_metadata_is_allowlisted_and_consent_retained(self):
        self.capture.update(screenshotsConsent=True, screenshots=[{
            "ts": 1700000001000, "dataUrl": "data:image/jpeg;base64,/9j/2Q==",
            "privateValue": "must not persist", "page": {"text": "must not persist"},
        }])
        rid = self.record()
        code, data, _ = self.request(f"/api/extension/recordings/{rid}/screenshots")
        self.assertEqual(code, 200)
        self.assertEqual(set(data["screenshots"][0]), {"ts", "dataUrl"})
        self.assertEqual(data["redaction_status"], "not_redacted")
        self.assertTrue(data["review_required"])
        self.assertNotIn("must not persist", json.dumps(data))
        self.assertTrue(storage.get_recording(rid)["screenshots_consent"])

    def test_delete_removes_capture_and_drafts(self):
        rid = self.record()
        self.request(f"/api/extension/tickets/{rid}", {})
        code, result, _ = self.request(f"/api/extension/recordings/{rid}", method="DELETE")
        self.assertEqual(code, 200)
        self.assertTrue(result["deleted"])
        self.assertEqual(self.request(f"/api/extension/export/{rid}")[0], 404)

    def test_multipart_preserves_binary_whitespace(self):
        video = b"\x00video \t\r\n"
        body = b'--test\r\nContent-Disposition: form-data; name="video"; filename="x.webm"\r\nContent-Type: video/webm\r\n\r\n' + video + b"\r\n--test--\r\n"
        headers = Message()
        headers["Content-Type"] = "multipart/form-data; boundary=test"
        headers["Content-Length"] = str(len(body))
        handler = type("Request", (), {"headers": headers, "rfile": io.BytesIO(body)})()
        _, files = routes._parse_multipart(handler)
        self.assertEqual(files["video"], video)


if __name__ == "__main__":
    unittest.main()
