"""Synthetic loopback contract tests; never contact the operator dashboard."""

import json
import io
import os
import socket
import sys
import tempfile
import threading
import unittest
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import integrations
import storage


class FakeDashboard(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        state = self.server.state
        state["gets"].append(self.path)
        if state.get("redirect"):
            self.send_response(302)
            self.send_header("Location", "http://203.0.113.1/private")
            self.end_headers()
            return
        if self.path == "/healthz":
            return self.reply(200, {"ok": True, "private_data": "must not be copied"})
        if state.get("readback_unavailable"):
            return self.reply(503, {"error": "temporarily unavailable"})
        item = next(iter(state["items"].values()), None)
        if item is None:
            return self.reply(200, {"error": "not found"})
        data = {**item, "key": "M-1234", "id": 1234, "native_status": "backlog"}
        if state.get("mismatch"):
            data["seed_key"] = "another-capture"
        if state.get("fence_missing"):
            data["tags"] = ["auto"]
        self.reply(200, data)

    def do_POST(self):
        state = self.server.state
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        state["posts"].append(payload)
        state["headers"].append(dict(self.headers))
        if state.get("redirect"):
            self.send_response(307)
            self.send_header("Location", "/unexpected-write")
            self.end_headers()
            return
        if "response_override" in state:
            return self.reply(200, state["response_override"])
        created = payload["seed_key"] not in state["items"]
        state["items"].setdefault(payload["seed_key"], payload)
        if state.pop("drop_after_write", False):
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        self.reply(200, {"ok": True, "item": 1234, "created": created})


class IntegrationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeDashboard)
        self.server.state = {"gets": [], "posts": [], "headers": [], "items": {}}
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.env = patch.dict(os.environ, {"PANTHER_DASHBOARD_URL": self.url})
        self.env.start()
        self.root = patch.object(storage, "ROOT", Path(self.temp.name))
        self.root.start()
        self.recording = {"id": "capture-123", "start_time": 100, "end_time": 130,
                          "source_url": "https://example.test/form?token=secret&mode=edit",
                          "video_path": "/private/recording.webm"}
        self.ticket = {"id": "draft-1", "title": "Keep form changes", "description": "Preserve the draft after navigation.",
                       "steps_to_reproduce": ["Edit the form", "Navigate back"],
                       "acceptance_criteria": ["The edited text is retained"],
                       "evidence": "Draft text disappeared after back navigation.", "screenshots": [4.2],
                       "evidence_refs": [{"type": "event", "event_index": 2}],
                       "provenance": {"model": "local-test", "origin": "model_proposal"}}

    def tearDown(self):
        self.root.stop()
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        self.temp.cleanup()

    def test_generic_export_is_portable_and_does_not_contact_dashboard(self):
        result = integrations.export_bundle(self.recording, {"data": {"tickets": [self.ticket]}})
        self.assertEqual(result["schema_version"], "1.2")
        self.assertEqual(result["tickets"][0]["acceptance_criteria"], ["The edited text is retained"])
        self.assertFalse(result["authority"]["execution_authorized"])
        self.assertTrue(result["tickets"][0]["requires_review"])
        text = json.dumps(result)
        self.assertNotIn("/private/", text)
        self.assertNotIn("=secret", text)
        self.assertEqual(self.server.state["gets"], [])
        self.assertEqual(self.server.state["posts"], [])

    def test_preview_contains_bounded_provenance_and_fences(self):
        self.ticket["description"] = "x" * 14000
        self.ticket["evidence"] = "y" * 7000
        result = integrations.preview_ticket(self.recording, self.ticket)
        payload = result["payload"]
        self.assertTrue(payload["detail"].startswith(integrations.FENCE))
        self.assertLessEqual(len(payload["detail"]), 4000)
        self.assertIn("Source: https://example.test/form", payload["detail"])
        self.assertIn("local-test", payload["detail"])
        self.assertIn("Expected result / acceptance criteria", payload["detail"])
        self.assertIn("Evidence references", payload["detail"])
        self.assertEqual(payload["status"], "backlog")
        self.assertIn("no-auto", payload["tags"])
        self.assertNotIn("auto", payload["tags"])
        self.assertEqual(payload["seed_key"], "panther:capture:capture-123:draft-1")
        self.assertEqual(self.server.state["posts"], [])

    def test_observed_draft_export_preserves_no_ai_provenance(self):
        self.ticket["provenance"] = {"mode": "observed", "model": None, "media_analyzed": False,
                                     "event_count": 3, "events_truncated": False}
        draft = integrations.export_bundle(self.recording, {"tickets": [self.ticket]})["tickets"][0]
        self.assertEqual(draft["provenance"]["origin"], "observed_evidence")
        self.assertIsNone(draft["provenance"]["model"])
        self.assertIs(draft["provenance"]["media_analyzed"], False)
        self.assertEqual(draft["provenance"]["event_count"], 3)

    def test_unverified_ai_hypothesis_is_separate_from_observed_evidence(self):
        self.ticket.update(
            hypothesis="The selected filter may reset after navigation.",
            suggested_verification_steps=["Check whether the filter resets"],
            provenance={"mode": "ai", "model": "local-test", "generation_revision": 2,
                        "evidence_kind": "observed_events", "proposal_verified": False,
                        "producer": "long-provider-metadata" * 30},
        )
        draft = integrations.export_bundle(self.recording, {"tickets": [self.ticket]})["tickets"][0]
        self.assertEqual(draft["hypothesis"], self.ticket["hypothesis"])
        self.assertEqual(draft["suggested_verification_steps"], ["Check whether the filter resets"])
        self.assertEqual(draft["steps_to_reproduce"], ["Edit the form", "Navigate back"])
        self.assertNotIn("Check whether the filter resets", draft["steps_to_reproduce"])
        self.assertEqual(draft["provenance"]["generation_revision"], 2)
        self.assertEqual(draft["provenance"]["evidence_kind"], "observed_events")
        self.assertIs(draft["provenance"]["proposal_verified"], False)
        preview = integrations.preview_ticket(self.recording, self.ticket)["payload"]
        self.assertIn('"generation_revision": 2', preview["detail"])
        self.assertIn('"proposal_verified": false', preview["detail"])
        self.assertIn('"evidence_kind": "observed_events"', preview["detail"])
        self.assertNotIn("Check whether the filter resets", preview["detail"])
        self.assertEqual(preview["seed_key"], "panther:capture:capture-123:draft-1")
        self.assertTrue(preview["detail"].startswith(integrations.FENCE))

    def test_submit_verifies_then_reuses_durable_receipt_without_post(self):
        first = integrations.submit_ticket(self.recording, self.ticket)
        second = integrations.submit_ticket(self.recording, self.ticket)
        self.assertTrue(first["ok"])
        self.assertTrue(first["verified"])
        self.assertEqual(first["ticket_key"], "M-1234")
        self.assertEqual(second["receipt"], first["receipt"])
        self.assertIs(first["previously_verified"], False)
        self.assertIs(second["previously_verified"], True)
        self.assertEqual(second["verified_at"], first["verified_at"])
        self.assertIsNotNone(second["verified_at"])
        self.assertEqual(len(self.server.state["posts"]), 1)
        self.assertEqual(self.server.state["gets"], ["/api/tix/ticket?key=M-1234&seen=0"])
        self.assertNotIn("Origin", self.server.state["headers"][0])
        receipts = list((Path(self.temp.name) / "deliveries").glob("*.json"))
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0].stat().st_mode & 0o777, 0o600)

    def test_destination_change_rejects_previous_confirmation_before_network(self):
        import destinations
        from api import routes
        preview = integrations.preview_ticket(self.recording, self.ticket)
        body = json.dumps({"ticket_id": self.ticket["id"], "confirmed": True,
                           "payload_hash": preview["payload_hash"]}).encode()
        headers = Message()
        for key, value in {"Host": "127.0.0.1:7890", "X-Panther-Client": "test",
                           "Content-Type": "application/json", "Content-Length": str(len(body))}.items():
            headers[key] = value

        class Request:
            command = "POST"
            path = "/api/extension/integrations/ticket-service/submit/capture-123"
            def send_response(self, status):
                self.status = status
            def send_header(self, *args):
                pass
            def end_headers(self):
                pass
            def log_error(self, *args):
                pass

        request = Request()
        request.headers, request.rfile, request.wfile = headers, io.BytesIO(body), io.BytesIO()
        with patch.dict(os.environ, {"PANTHER_DASHBOARD_URL": "http://127.0.0.1:1"}), \
                patch.object(storage, "get_recording", return_value=self.recording), \
                patch.object(routes, "_reviewed_ticket", return_value=self.ticket), \
                patch.object(destinations, "submit") as submit, \
                patch.object(integrations, "_request") as network:
            changed = integrations.preview_ticket(self.recording, self.ticket)
            self.assertNotEqual(changed["payload_hash"], preview["payload_hash"])
            self.assertEqual(changed["seed_key"], preview["seed_key"])
            routes.handle_request(request)
            self.assertEqual(request.status, 409)
            self.assertIn("Preview and explicitly confirm", json.loads(request.wfile.getvalue())["error"])
            submit.assert_not_called()
            network.assert_not_called()
        self.assertEqual(self.server.state["posts"], [])

    def test_bounded_outbound_payload_change_invalidates_preview_hash(self):
        original = integrations.preview_ticket(self.recording, self.ticket)
        with patch.object(integrations, "SOURCE", "panther-intent-capture:changed-contract"):
            changed = integrations.preview_ticket(self.recording, self.ticket)
        self.assertEqual(original["seed_key"], changed["seed_key"])
        self.assertNotEqual(original["payload"], changed["payload"])
        self.assertNotEqual(original["payload_hash"], changed["payload_hash"])

    def test_edited_submitted_draft_is_a_conflict_not_a_silent_update(self):
        integrations.submit_ticket(self.recording, self.ticket)
        self.ticket["description"] = "Changed intent"
        result = integrations.submit_ticket(self.recording, self.ticket)
        self.assertEqual(result["state"], "conflict")
        self.assertFalse(result["ok"])
        self.assertEqual(len(self.server.state["posts"]), 1)

    def test_lost_response_retries_identical_seed_and_deduplicates(self):
        self.server.state["drop_after_write"] = True
        first = integrations.submit_ticket(self.recording, self.ticket)
        self.assertEqual(first["state"], "pending")
        second = integrations.submit_ticket(self.recording, self.ticket)
        self.assertTrue(second["ok"])
        self.assertFalse(second["created"])
        self.assertEqual(len(self.server.state["items"]), 1)
        self.assertEqual(self.server.state["posts"][0], self.server.state["posts"][1])

    def test_known_item_pending_readback_retries_get_only(self):
        self.server.state["readback_unavailable"] = True
        first = integrations.submit_ticket(self.recording, self.ticket)
        self.assertEqual(first["state"], "pending")
        self.assertFalse(first["verified"])
        self.server.state["readback_unavailable"] = False
        second = integrations.submit_ticket(self.recording, self.ticket)
        self.assertTrue(second["ok"])
        self.assertEqual(len(self.server.state["posts"]), 1)

    def test_null_zero_boolean_or_missing_item_is_not_success(self):
        for item in (None, 0, True, -1, "1234"):
            with self.subTest(item=item):
                self.server.state["response_override"] = {"ok": True, "item": item, "created": False}
                result = integrations.submit_ticket(self.recording, self.ticket)
                self.assertEqual(result["state"], "refused")
                self.assertFalse(result["ok"])
                self.assertEqual(self.server.state["gets"], [])

    def test_readback_wrong_identity_or_missing_fence_remains_pending(self):
        self.server.state["mismatch"] = True
        first = integrations.submit_ticket(self.recording, self.ticket)
        self.assertFalse(first["verified"])
        self.server.state["mismatch"] = False
        self.server.state["fence_missing"] = True
        second = integrations.submit_ticket(self.recording, self.ticket)
        self.assertFalse(second["ok"])
        self.assertEqual(second["state"], "pending")
        self.assertEqual(len(self.server.state["posts"]), 1)

    def test_redirects_are_not_followed_for_health_or_writes(self):
        self.server.state["redirect"] = True
        result = integrations.dashboard_status()
        self.assertFalse(result["ok"])
        self.assertIn("redirect", result["error"])
        result = integrations.submit_ticket(self.recording, self.ticket)
        self.assertFalse(result["ok"])
        self.assertEqual(len(self.server.state["posts"]), 1)
        self.assertEqual(self.server.state["gets"], ["/healthz"])

    def test_nonloopback_and_ambiguous_destinations_fail_before_network(self):
        for target in ("https://example.com", "http://169.254.169.254", "http://127.0.0.1.evil.test", "file:///etc/passwd",
                       "http://127.0.0.1:8080/path", "http://user:pass@127.0.0.1", "http://127.0.0.1?query=1",
                       "http://[::ffff:192.168.1.1]:8080", "http://localhost#fragment"):
            with self.subTest(target=target), patch.dict(os.environ, {"PANTHER_DASHBOARD_URL": target}):
                with self.assertRaises(ValueError):
                    integrations.preview_ticket(self.recording, self.ticket)
        self.assertEqual(self.server.state["posts"], [])
        self.assertEqual(self.server.state["gets"], [])

    def test_health_only_returns_safe_reachability(self):
        result = integrations.dashboard_status()
        self.assertTrue(result["ok"])
        self.assertEqual(result["state"], "reachable")
        self.assertNotIn("private_data", result)
        self.assertEqual(self.server.state["gets"], ["/healthz"])

    def test_unconfigured_destination_never_contacts_a_service(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(integrations, "_request") as request:
            status = integrations.dashboard_status()
            self.assertEqual(status["state"], "unconfigured")
            self.assertEqual(status["url"], "")
            with self.assertRaisesRegex(ValueError, "Configure"):
                integrations.preview_ticket(self.recording, self.ticket)
            exported = integrations.export_bundle(self.recording, {"tickets": [self.ticket]})
            self.assertTrue(exported["authority"]["export_only"])
            request.assert_not_called()

    def test_unavailable_dashboard_preserves_uncertain_receipt(self):
        with patch.object(integrations, "_request", side_effect=TimeoutError("timeout")):
            result = integrations.submit_ticket(self.recording, self.ticket)
        self.assertEqual(result["state"], "pending")
        self.assertFalse(result["ok"])
        self.assertTrue(list((Path(self.temp.name) / "deliveries").glob("*.json")))

    def test_receipt_write_failure_prevents_post(self):
        with patch.object(storage, "write_json", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                integrations.submit_ticket(self.recording, self.ticket)
        self.assertEqual(self.server.state["posts"], [])

    def test_invalid_identity_is_rejected(self):
        for identity in ("", "../escape", "one:two"):
            ticket = {**self.ticket, "id": identity}
            with self.assertRaises(ValueError):
                integrations.preview_ticket(self.recording, ticket)


if __name__ == "__main__":
    unittest.main()
