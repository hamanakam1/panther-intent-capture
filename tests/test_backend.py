"""Synthetic backend regressions; all data stays in an isolated temporary directory."""
import concurrent.futures
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import inference
import redaction
import storage
import tickets


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="panther-test-")
        self.root = Path(self.temporary.name)
        self.patch = patch.multiple(storage, ROOT=self.root,
                                    RECORDINGS_DIR=self.root / "recordings",
                                    EVENTS_DIR=self.root / "events",
                                    INFERENCE_DIR=self.root / "inference",
                                    CONSENT_LOG=self.root / "consent.log",
                                    MANIFEST_FILE=self.root / "manifest.json")
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temporary.cleanup()

    def create(self, session="", **kwargs):
        return storage.create_recording(tab_id=1, start_time=1000, end_time=1002,
                                        event_count=1, session_id=session, extension_id="test-extension", **kwargs)

    def test_session_retries_are_idempotent_and_do_not_replace_metadata(self):
        first = self.create("session-1", goal="original")
        second = self.create("session-1", goal="retry")
        self.assertEqual(first, second)
        self.assertEqual(storage.get_recording(first)["goal"], "original")
        self.assertEqual(len(storage.list_recordings()), 1)

    def test_threaded_creates_do_not_lose_records(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(lambda index: self.create(f"session-{index}"), range(32)))
        self.assertEqual(len(set(ids)), 32)
        self.assertEqual({record["id"] for record in storage.list_recordings()}, set(ids))
        self.assertEqual(os.stat(storage.MANIFEST_FILE).st_mode & 0o777, 0o600)

    def test_delete_removes_media_events_screenshots_and_derived_results(self):
        storage.ensure_dirs()
        paths = [storage.RECORDINGS_DIR / filename for filename in ("video.webm", "events.json", "screenshots.json")]
        for path in paths:
            path.write_bytes(b"synthetic fixture")
        rid = self.create(video_path=paths[0], events_path=paths[1], screenshots_path=paths[2])
        storage.save_inference_result(rid, {"narrative": "synthetic"})
        tickets.save_tickets(rid, tickets.generate_drafts(storage.get_recording(rid), []))
        self.assertTrue(storage.delete_recording(rid))
        self.assertTrue(all(not path.exists() for path in paths))
        self.assertFalse(list((self.root / "inference").glob("*.json")))
        self.assertFalse(list((self.root / "tickets").glob("*.json")))
        self.assertIsNone(storage.get_recording(rid))

    def test_ttl_removes_derived_data_when_library_is_read(self):
        rid = self.create()
        tickets.save_tickets(rid, tickets.generate_drafts(storage.get_recording(rid), []))
        manifest = storage._load_manifest()
        manifest[rid]["created_at"] = time.time() - storage.TTL_SECONDS - 10
        storage.write_json(storage.MANIFEST_FILE, manifest)
        self.assertEqual(storage.list_recordings(), [])
        self.assertFalse((self.root / "tickets" / f"{rid}.json").exists())

    def test_corrupt_manifest_is_not_overwritten(self):
        storage.MANIFEST_FILE.write_text("invalid JSON")
        with self.assertRaises(ValueError):
            self.create()
        self.assertEqual(storage.MANIFEST_FILE.read_text(), "invalid JSON")

    def test_retention_does_not_delete_artifacts_from_corrupt_metadata(self):
        storage.ensure_dirs()
        events = storage.EVENTS_DIR / "retained.json"
        events.write_bytes(b"retained capture")
        rid = self.create(events_path=events)
        original = storage._load_manifest()
        for timestamp in (None, "yesterday", -1, True, float("nan"), float("inf")):
            with self.subTest(timestamp=timestamp):
                damaged = json.loads(json.dumps(original))
                if timestamp is None:
                    damaged[rid].pop("created_at")
                else:
                    damaged[rid]["created_at"] = timestamp
                # Deliberately model an externally corrupted file, including
                # nonfinite values that the normal writer refuses to emit.
                storage.MANIFEST_FILE.write_text(json.dumps(damaged))
                before = storage.MANIFEST_FILE.read_bytes()
                with self.assertRaises(ValueError):
                    storage.list_recordings()
                self.assertEqual(events.read_bytes(), b"retained capture")
                self.assertEqual(storage.MANIFEST_FILE.read_bytes(), before)

    def test_corrupt_identity_and_path_fail_before_deleting_any_artifact(self):
        storage.ensure_dirs()
        events = storage.EVENTS_DIR / "retained.json"
        events.write_bytes(b"retained capture")
        rid = self.create(events_path=events)
        original = storage._load_manifest()
        for key, value in (("id", "different-record"), ("screenshots_path", str(self.root.parent / "outside.json")), ("inference", [])):
            with self.subTest(field=key):
                damaged = json.loads(json.dumps(original))
                damaged[rid][key] = value
                storage.write_json(storage.MANIFEST_FILE, damaged)
                before = storage.MANIFEST_FILE.read_bytes()
                with self.assertRaises(ValueError):
                    storage.delete_recording(rid)
                self.assertEqual(events.read_bytes(), b"retained capture")
                self.assertEqual(storage.MANIFEST_FILE.read_bytes(), before)

    def test_failed_deletion_commit_preserves_existing_capture(self):
        storage.ensure_dirs()
        events = storage.EVENTS_DIR / "retained.json"
        events.write_bytes(b"retained capture")
        rid = self.create(events_path=events)
        before = storage.MANIFEST_FILE.read_bytes()
        with patch.object(storage, "_save_manifest", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                storage.delete_recording(rid)
        self.assertEqual(events.read_bytes(), b"retained capture")
        self.assertEqual(storage.MANIFEST_FILE.read_bytes(), before)

    def test_interrupted_deletion_is_durable_and_resumes_on_next_read(self):
        storage.ensure_dirs()
        events = storage.EVENTS_DIR / "removing.json"
        events.write_bytes(b"synthetic capture")
        rid = self.create(events_path=events)
        save = storage._save_manifest
        calls = 0

        def fail_final_save(manifest):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("final save interrupted")
            save(manifest)

        with patch.object(storage, "_save_manifest", side_effect=fail_final_save):
            with self.assertRaises(OSError):
                storage.delete_recording(rid)
        self.assertTrue(storage._load_manifest()[rid]["_deleting"])
        self.assertFalse(events.exists())
        self.assertEqual(storage.list_recordings(), [])
        self.assertEqual(storage._load_manifest(), {})

    def test_cap_eviction_commit_failure_preserves_old_capture(self):
        storage.ensure_dirs()
        events = storage.EVENTS_DIR / "old.json"
        events.write_bytes(b"retained until committed")
        old_id = self.create(events_path=events)
        with patch.object(storage, "MAX_RECORDINGS", 1), \
             patch.object(storage, "_save_manifest", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                self.create()
        self.assertEqual(events.read_bytes(), b"retained until committed")
        self.assertEqual([row["id"] for row in storage.list_recordings()], [old_id])

    def test_cap_eviction_removes_only_oldest_capture_and_derived_data(self):
        storage.ensure_dirs()
        events = storage.EVENTS_DIR / "oldest.json"
        events.write_bytes(b"oldest synthetic capture")
        oldest = self.create(events_path=events)
        tickets.save_tickets(oldest, tickets.generate_drafts(storage.get_recording(oldest), []))
        second = self.create()
        with patch.object(storage, "MAX_RECORDINGS", 2):
            newest = self.create()
            self.assertEqual({row["id"] for row in storage.list_recordings()}, {second, newest})
        self.assertFalse(events.exists())
        self.assertFalse((self.root / "tickets" / f"{oldest}.json").exists())

    def test_invalid_paths_and_ids_are_rejected(self):
        for invalid in ("../secret", "a/b", "a\\b", "", ".", "x" * 81):
            with self.assertRaises(ValueError):
                storage.get_recording(invalid)
        with self.assertRaises(ValueError):
            self.create(events_path=self.root.parent / "outside.json")

    def test_drafts_persist_as_one_result_and_can_be_retried_after_failure(self):
        rid = self.create()
        recording = storage.get_recording(rid)
        with patch.object(tickets, "_ollama_decompose", side_effect=ConnectionError("offline")):
            with self.assertRaises(tickets.DraftGenerationError):
                tickets.generate_drafts(recording, [], use_ai=True)
        self.assertIsNone(tickets.load_tickets(rid))
        result = tickets.generate_drafts(recording, [])
        result_id = tickets.save_tickets(rid, result)
        self.assertEqual(result_id, tickets.save_tickets(rid, result))
        self.assertEqual(tickets.load_tickets(rid)["data"], result)
        self.assertEqual(len(list((self.root / "tickets").glob("*.json"))), 1)

    def test_switching_modes_preserves_reviewed_edits(self):
        rid = self.create()
        recording = storage.get_recording(rid)
        evidence = tickets.generate_drafts(recording, [])
        evidence["tickets"][0]["title"] = "Reviewed title that must survive"
        tickets.save_tickets(rid, evidence)
        with patch.object(tickets, "_ollama_decompose", return_value='[{"title":"AI suggestion"}]'):
            ai = tickets.generate_drafts(recording, [], use_ai=True)
        tickets.save_tickets(rid, ai)
        self.assertEqual(tickets.load_tickets(rid)["data"]["mode"], "ai")
        previous = tickets.load_tickets(rid, mode="observed")
        self.assertEqual(previous["data"]["tickets"][0]["title"], "Reviewed title that must survive")
        tickets.save_tickets(rid, previous["data"])
        self.assertEqual(tickets.load_tickets(rid)["data"], evidence)
        self.assertEqual(tickets.load_tickets(rid, mode="ai")["data"], ai)

    def test_a_regenerated_draft_keeps_the_fields_a_reviewer_changed(self):
        rid = self.create()
        recording = storage.get_recording(rid)
        # A draft stored by an earlier generation revision.
        legacy = tickets.generate_drafts(recording, [])
        legacy["generation_revision"] = tickets.GENERATION_REVISION - 1
        legacy["tickets"][0]["title"] = "Reviewed title that must survive"
        legacy["tickets"][0]["reviewed"] = {"title": "Reviewed title that must survive"}
        tickets.save_tickets(rid, legacy)
        # The stale draft is not served for regeneration.
        self.assertIsNone(tickets.load_tickets(rid, mode="observed"))
        regenerated = tickets.generate_drafts(recording, [])
        tickets.save_tickets(rid, regenerated)
        saved = tickets.load_tickets(rid, mode="observed")
        self.assertEqual(saved["data"]["tickets"][0]["title"], "Reviewed title that must survive")
        # A field nobody reviewed is not pinned to the older draft.
        self.assertEqual(saved["data"]["tickets"][0]["evidence"], regenerated["tickets"][0]["evidence"])

    def test_old_ai_generation_is_not_reused_but_file_is_preserved(self):
        rid = self.create()
        legacy = {"mode": "ai", "tickets": [{"id": "old-draft", "title": "Unsupported claim"}]}
        tickets.save_tickets(rid, legacy)
        path = self.root / "tickets" / f"{rid}.json"
        before = path.read_bytes()
        self.assertIsNone(tickets.load_tickets(rid, mode="ai"))
        self.assertEqual(tickets.load_tickets(rid)["data"], legacy)
        self.assertEqual(path.read_bytes(), before)


class DraftTests(unittest.TestCase):
    recording = {"id": "test-recording", "start_time": 1000, "url": "http://localhost:8080/?token=secret#work",
                 "goal": "Fix the Save button", "title": "Dashboard", "video_path": ""}
    # The extension sends the accessible name as "label"; it never sends page text.
    events = [{"type": "click", "ts": 1001500, "target": {"tag": "button", "label": "Save"}}]

    def test_observed_mode_never_calls_model_and_preserves_evidence(self):
        with patch.object(tickets, "_ollama_decompose", side_effect=AssertionError("must not run")):
            result = tickets.generate_drafts(self.recording, self.events)
        draft = result["tickets"][0]
        self.assertEqual(result["mode"], "observed")
        self.assertIsNone(result["model"])
        self.assertEqual(draft["steps_to_reproduce"], ["click: Save"])
        self.assertEqual(draft["provenance"]["source_url"], "http://localhost:8080/#work")
        self.assertEqual(draft["evidence_refs"][0]["event_index"], 1)
        self.assertTrue(draft["requires_review"])
        self.assertFalse(draft["execution_authorized"])
        self.assertEqual(draft["id"], tickets.generate_drafts(self.recording, self.events)["tickets"][0]["id"])

    def test_ai_failure_and_malformed_json_are_explicit_errors(self):
        for raw in ("not json", "{}", '[{"title": null}]', '[4]'):
            with self.subTest(raw=raw), patch.object(tickets, "_ollama_decompose", return_value=raw):
                with self.assertRaises(tickets.DraftGenerationError):
                    tickets.generate_drafts(self.recording, self.events, use_ai=True)

    def test_model_cannot_grant_execution_or_invent_evidence_references(self):
        model = [{"title": "Fix Save", "status": "approved", "execution_authorized": True,
                  "priority": "urgent", "steps_to_reproduce": "not an array",
                  "event_indices": [1, 999, True, -1], "screenshots": [12]}]
        with patch.object(tickets, "_ollama_decompose", return_value=json.dumps(model)):
            draft = tickets.generate_drafts(self.recording, self.events, use_ai=True)["tickets"][0]
        self.assertEqual(draft["status"], "draft")
        self.assertFalse(draft["execution_authorized"])
        self.assertEqual(draft["priority"], "medium")
        self.assertEqual(draft["steps_to_reproduce"], ["click: Save"])
        self.assertEqual([ref["event_index"] for ref in draft["evidence_refs"]], [1])
        self.assertEqual(draft["screenshots"], [])

    def test_hallucinated_model_claims_never_become_observed_evidence(self):
        model = [{"title": "Save loses all work", "description": "The Save button deletes records.",
                  "steps_to_reproduce": ["Save deleted all records", "Error dialog proves data loss"],
                  "evidence": "Confirmed data loss shown by error dialog", "event_indices": [1, 999]}]
        with patch.object(tickets, "_ollama_decompose", return_value=json.dumps(model)):
            result = tickets.generate_drafts(self.recording, self.events, use_ai=True)
        draft = result["tickets"][0]
        self.assertEqual(result["generation_revision"], tickets.GENERATION_REVISION)
        self.assertEqual(draft["steps_to_reproduce"], ["click: Save"])
        self.assertIn("do not establish a bug", draft["evidence"])
        self.assertNotIn("data loss", draft["evidence"])
        self.assertNotIn("dialog", draft["evidence"])
        self.assertTrue(draft["title"].startswith("Investigate: "))
        self.assertTrue(draft["description"].startswith("Unverified AI proposal: "))
        self.assertEqual(draft["hypothesis"], model[0]["description"])
        self.assertEqual(draft["suggested_verification_steps"], model[0]["steps_to_reproduce"])
        self.assertFalse(draft["provenance"]["proposal_verified"])

    def test_ai_without_valid_references_uses_observed_context_only(self):
        with patch.object(tickets, "_ollama_decompose", return_value='[{"title":"Investigate saving","event_indices":[500]}]'):
            draft = tickets.generate_drafts(self.recording, self.events, use_ai=True)["tickets"][0]
        self.assertEqual(draft["title"], "Investigate saving")
        self.assertEqual(draft["steps_to_reproduce"], ["click: Save"])
        self.assertEqual([ref["event_index"] for ref in draft["evidence_refs"]], [1])

    def test_model_cannot_reorder_the_observed_timeline(self):
        events = self.events + [{"type": "click", "ts": 1001600, "target": {"tag": "button", "label": "Cancel"}}]
        with patch.object(tickets, "_ollama_decompose", return_value='[{"title":"Investigate saving","event_indices":[2,1,2]}]'):
            draft = tickets.generate_drafts(self.recording, events, use_ai=True)["tickets"][0]
        self.assertEqual(draft["steps_to_reproduce"], ["click: Save", "click: Cancel"])
        self.assertEqual([ref["event_index"] for ref in draft["evidence_refs"]], [1, 2])

    def test_frame_sampler_receives_relative_seconds(self):
        with patch.object(tickets, "_sample_key_frames", return_value=[]) as sample, \
             patch.object(tickets, "_ollama_decompose", return_value="[]"):
            tickets.generate_drafts(self.recording, self.events, use_ai=True)
        sample.assert_called_once_with("", [1.5])

    def test_recording_evidence_scope_is_bounded_and_marked(self):
        draft = tickets.generate_drafts(self.recording, self.events * 400)["tickets"][0]
        self.assertEqual(draft["provenance"]["event_count"], 300)
        self.assertTrue(draft["provenance"]["events_truncated"])
        self.assertEqual(draft["provenance"]["events_total"], 400)

    def test_truncated_evidence_says_so_in_words(self):
        """The reader of a draft or a delivered ticket sees the evidence sentence."""
        draft = tickets.generate_drafts(self.recording, self.events * 400)["tickets"][0]
        self.assertIn("The first 300 of 400 recorded events were used", draft["evidence"])
        self.assertIn("the rest were not analysed", draft["evidence"])
        self.assertNotIn("400 recorded events;", draft["evidence"])

    def test_ai_evidence_says_so_in_words_when_truncated(self):
        with patch.object(tickets, "_ollama_decompose", return_value='[{"title": "Investigate saving", "event_indices": [1]}]'):
            draft = tickets.generate_drafts(self.recording, self.events * 400, use_ai=True)["tickets"][0]
        self.assertIn("The first 300 of 400 recorded events were used", draft["evidence"])
        self.assertIn("the rest were not analysed", draft["evidence"])

    def test_untruncated_evidence_keeps_its_plain_wording(self):
        draft = tickets.generate_drafts(self.recording, self.events)["tickets"][0]
        self.assertEqual(draft["evidence"], "1 recorded event; no AI inference was performed.")
        self.assertFalse(draft["provenance"]["events_truncated"])


class DiagnosticsTests(unittest.TestCase):
    """Page-reported failures are observations, and they stay observations."""

    recording = {"id": "diagnostic-recording", "start_time": 1000, "url": "http://localhost:8080/page",
                 "goal": "Fix the Save button", "title": "Dashboard", "video_path": ""}
    events = [
        {"type": "click", "ts": 1001500, "target": {"tag": "button", "label": "Save"}},
        {"type": "diagnostic", "ts": 1001800, "url": "http://localhost:8080/page",
         "diagnostic": {"kind": "uncaught_exception", "message": "TypeError: x is not a function",
                        "source": "http://localhost:8080/app.js", "line": 12}},
        {"type": "diagnostic", "ts": 1001900, "url": "http://localhost:8080/page",
         "diagnostic": {"kind": "http_error", "message": "A request returned HTTP 500",
                        "source": "http://localhost:8080/api/tickets", "status": 500}},
    ]

    def test_an_evidence_draft_names_the_failure_without_claiming_a_defect(self):
        result = tickets.generate_drafts(self.recording, self.events)
        draft = result["tickets"][0]
        self.assertEqual(len(draft["diagnostics"]), 2)
        self.assertEqual(draft["diagnostics"][0]["kind"], "uncaught_exception")
        self.assertEqual(draft["diagnostics"][0]["event_index"], 2)
        self.assertEqual(draft["diagnostics"][1]["status"], 500)
        self.assertIn("Page-reported failures", draft["description"])
        self.assertIn("TypeError: x is not a function", draft["description"])
        self.assertIn("not verified defects", draft["description"])
        self.assertIn("The page reported 2 failure(s)", draft["evidence"])
        self.assertEqual(draft["provenance"]["diagnostic_count"], 2)
        # The failure is an observation, never a verified defect or a permission.
        self.assertFalse(draft["provenance"]["proposal_verified"])
        self.assertFalse(draft["execution_authorized"])
        self.assertTrue(draft["requires_review"])

    def test_a_failure_becomes_a_readable_reproduction_step(self):
        result = tickets.generate_drafts(self.recording, self.events)
        steps = result["tickets"][0]["steps_to_reproduce"]
        self.assertEqual(steps[0], "click: Save")
        self.assertTrue(steps[1].startswith("page failure: uncaught exception: TypeError"))
        self.assertIn("HTTP 500", steps[2])

    def test_a_model_proposal_receives_the_failures_but_keeps_them_separate(self):
        captured = {}

        def fake_decompose(frames, events_summary, goal="", failures_summary="", friction_summary=""):
            captured["failures"] = failures_summary
            captured["friction"] = friction_summary
            captured["events"] = events_summary
            return json.dumps([{"title": "Save fails", "description": "Unverified model claim",
                                "event_indices": [1, 2]}])

        with patch.object(tickets, "_ollama_decompose", side_effect=fake_decompose):
            result = tickets.generate_drafts(self.recording, self.events, use_ai=True)
        self.assertIn("TypeError: x is not a function", captured["failures"])
        self.assertIn("HTTP 500", captured["failures"])
        draft = result["tickets"][0]
        self.assertEqual(draft["hypothesis"], "Unverified model claim")
        self.assertIn("Unverified AI proposal:", draft["description"])
        self.assertIn("Page-reported failures", draft["description"])
        self.assertIn("do not establish a bug", draft["evidence"])
        self.assertIn("The page reported 1 failure(s)", draft["evidence"])
        # Only the failure the proposal's own evidence points at is attached.
        self.assertEqual(len(draft["diagnostics"]), 1)
        self.assertEqual(draft["diagnostics"][0]["event_index"], 2)

    def test_a_capture_without_failures_reports_none(self):
        report = tickets.capture_diagnostics([{"type": "click", "ts": 1, "target": {"tag": "button"}}])
        self.assertEqual(report["count"], 0)
        self.assertEqual(report["failures"], [])
        self.assertEqual(report["kinds"], {})
        self.assertIn("not verified defects", report["interpretation"])

    def test_the_diagnostic_summary_states_what_a_failure_is_and_is_not(self):
        report = tickets.capture_diagnostics(self.events)
        self.assertEqual(report["count"], 2)
        self.assertEqual(report["kinds"], {"uncaught_exception": 1, "http_error": 1})
        self.assertIn("not verified defects", report["interpretation"])
        self.assertIn("not permission to act", report["interpretation"])
        self.assertTrue(report["failures"][0]["summary"].startswith("uncaught exception:"))
        self.assertTrue(report["failures"][1]["summary"].startswith("HTTP 500"))

    def test_a_diagnostic_is_redacted_like_any_other_captured_value(self):
        event = {"type": "diagnostic", "ts": 1, "url": "http://localhost:8080/page",
                 "diagnostic": {"kind": "http_error", "message": "failed for user@example.test",
                                "source": "http://localhost:8080/api?token=secret", "status": 500}}
        clean = redaction.sanitize_capture_event(event)
        self.assertNotIn("user@example.test", clean["diagnostic"]["message"])
        self.assertNotIn("secret", clean["diagnostic"]["source"])
        self.assertEqual(clean["diagnostic"]["status"], 500)


class FrictionTests(unittest.TestCase):
    """Possible-friction hypotheses are possibilities, and they reach the ticket."""

    recording = {"id": "friction-recording", "start_time": 1000, "url": "http://localhost:8080/page",
                 "goal": "Fix the Save button", "title": "Dashboard", "video_path": ""}

    def clicks(self, count, tag="button", control_id="save", start=1000, step=200):
        return [{"type": "click", "ts": start + index * step,
                 "url": "http://localhost:8080/page",
                 "target": {"tag": tag, "id": control_id, "label": "Save"}}
                for index in range(count)]

    def test_repeated_clicks_on_one_control_are_a_hypothesis(self):
        result = tickets.generate_drafts(self.recording, self.clicks(4))
        friction = result["tickets"][0]["friction"]
        repeated = [item for item in friction if item["kind"] == "repeated_clicks"]
        self.assertEqual(len(repeated), 1)
        self.assertTrue(repeated[0]["hypothesis"])
        self.assertEqual(repeated[0]["event_indices"], [1, 2, 3, 4])
        self.assertIn("No failure is verified", repeated[0]["detail"])
        self.assertIn("Possible friction", result["tickets"][0]["description"])
        self.assertIn("possible friction signal(s)", result["tickets"][0]["evidence"])

    def test_two_clicks_are_not_friction_and_different_controls_do_not_merge(self):
        self.assertEqual(tickets._friction(self.clicks(2)), [])
        separate = self.clicks(2, control_id="save") + self.clicks(2, control_id="cancel", start=5000)
        self.assertEqual(tickets._friction(separate), [])

    def test_clicks_outside_the_window_are_not_repeated_clicks(self):
        spread = [{"type": "click", "ts": 1000 + index * 20000,
                    "url": "http://localhost:8080/page",
                    "target": {"tag": "button", "id": "save"}} for index in range(4)]
        self.assertEqual(tickets._friction(spread), [])

    def test_a_click_on_a_non_control_is_reported(self):
        events = [{"type": "click", "ts": 1000, "url": "http://localhost:8080/page",
                   "target": {"tag": "div", "id": "tile", "inert": True}}]
        friction = tickets._friction(events)
        self.assertEqual(len(friction), 1)
        self.assertEqual(friction[0]["kind"], "non_control_click")
        self.assertEqual(friction[0]["event_indices"], [1])
        self.assertTrue(friction[0]["hypothesis"])
        self.assertIn("No failure is verified", friction[0]["detail"])

    def test_a_control_without_a_distinguishing_identifier_is_never_merged(self):
        events = [{"type": "click", "ts": 1000 + index * 200, "url": "http://localhost:8080/page",
                   "target": {"tag": "button", "label": "Save"}} for index in range(4)]
        self.assertEqual(tickets._friction(events), [])

    def test_friction_is_bounded_and_ordered(self):
        events = []
        for index in range(20):
            events.append({"type": "click", "ts": 1000 + index * 100,
                           "url": "http://localhost:8080/page",
                           "target": {"tag": "button", "id": f"control-{index}"}})
        friction = tickets._friction(events)
        self.assertLessEqual(len(friction), tickets.MAX_FRICTION)
        self.assertEqual([item["event_indices"][0] for item in friction],
                         sorted(item["event_indices"][0] for item in friction))


class PrivacyTests(unittest.TestCase):
    def test_url_redaction_and_nested_secret_descriptors(self):
        events = [{"type": "change", "url": "https://user:pass@example.test/path?token=abc#access_token=def",
                   "target": {"name": "password", "value": "very-secret", "text": "very-secret"}}]
        clean = redaction.sanitize_events(events)[0]
        self.assertEqual(clean["url"], "https://example.test/path")
        self.assertNotIn("value", clean["target"])
        self.assertNotIn("very-secret", json.dumps(clean))

    def test_server_event_allowlist_discards_input_values_keys_and_page_text(self):
        raw = [{"type": "change", "ts": 1234, "value": "private input", "key": "a",
                "page": {"text": "private page"}, "target": {"tag": "input", "value": "private input", "text": "private input", "label": "private input"}},
               {"type": "keydown", "key": "password"},
               {"type": "click", "target": {"tag": "button", "label": "Bearer abc123 person@example.test"}}]
        clean = redaction.sanitize_events(raw)
        self.assertEqual(len(clean), 2)
        self.assertEqual(clean[0], {"type": "change", "ts": 1234, "url": "", "target": {"tag": "input"}})
        self.assertEqual(clean[1]["target"]["label"], "[REDACTED] [EMAIL]")
        self.assertNotIn("private", json.dumps(clean))
        self.assertEqual(redaction.sanitize_url("https://example.test/token/topsecret"), "https://example.test/token/REDACTED")

    def test_inference_cannot_use_remote_or_credentialed_endpoints(self):
        for endpoint in ("https://api.example.test/v1", "http://192.168.1.20/v1", "http://user:pass@localhost/v1"):
            with self.subTest(endpoint=endpoint), patch.object(inference, "OLLAMA_ENDPOINT", endpoint):
                with self.assertRaises(ValueError):
                    inference.local_endpoint()
        with patch.object(inference, "OLLAMA_ENDPOINT", "http://127.0.0.1:11434/v1/"):
            self.assertEqual(inference.local_endpoint(), "http://127.0.0.1:11434/v1")

    def test_session_identifiers_never_survive_a_url(self):
        """A session identifier is a credential in disguise; the extension redacts it."""
        self.assertEqual(redaction.sanitize_url("https://example.test/session/abc123"),
                         "https://example.test/session/REDACTED")
        self.assertEqual(redaction.sanitize_url("https://example.test/my-session-id/42"),
                         "https://example.test/my-session-id/REDACTED")
        self.assertEqual(redaction.sanitize_url("https://example.test/#session"),
                         "https://example.test/")

    def test_an_event_always_carries_a_timestamp(self):
        """Without one, the event drops out of the ticket's reproduction steps."""
        for payload in ({"type": "click", "url": "https://example.test/"},
                        {"type": "click", "ts": "later", "url": "https://example.test/"}):
            with self.subTest(payload=payload):
                clean = redaction.sanitize_capture_event(payload)
                self.assertIsInstance(clean["ts"], int)
                self.assertGreater(clean["ts"], 0)

    def test_page_text_is_not_read_from_a_text_field(self):
        """The extension sends an accessible name as "label" and never page text."""
        clean = redaction.sanitize_capture_event(
            {"type": "click", "ts": 1, "target": {"tag": "button", "text": "private page text"}}
        )
        self.assertEqual(clean["target"], {"tag": "button"})
        self.assertNotIn("private", json.dumps(clean))


if __name__ == "__main__":
    unittest.main()
