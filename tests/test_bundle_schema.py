"""Portable contract tests using synthetic captures, without delivery or inference.

The structural checks always run with the standard library. When jsonschema is
available, Draft 2020-12 meta-schema and positive/negative instance validation
also run. Those tests report explicit skips if the optional validator is absent;
the standard-library checks are not a substitute for schema validation.
"""

import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import integrations
import tickets

try:
    from jsonschema import Draft202012Validator
except ImportError:
    Draft202012Validator = None


SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schemas" / "intent-bundle.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
RECORDING = {
    "id": "schema-capture-1", "url": "http://127.0.0.1:8080/?token=private#work-board",
    "title": "Synthetic dashboard", "goal": "Keep my selected filter after navigation",
    "capture_mode": "events", "start_time": 1000.25, "end_time": 1002.75,
    "duration_ms": 2500, "event_count": 2, "screenshot_count": 1,
}
EVENTS = [
    {"type": "click", "ts": 1000250, "target": {"tag": "button", "label": "Choose filter"}},
    {"type": "navigation", "ts": 1001250, "url": "http://127.0.0.1:8080/#work-board"},
]
FAILURE_EVENTS = EVENTS + [
    {"type": "diagnostic", "ts": 1001750, "url": "http://127.0.0.1:8080/work-board",
     "diagnostic": {"kind": "http_error", "message": "A request returned HTTP 500",
                    "source": "http://127.0.0.1:8080/api/tickets", "status": 500}},
    {"type": "diagnostic", "ts": 1001850, "url": "http://127.0.0.1:8080/work-board",
     "diagnostic": {"kind": "uncaught_exception", "message": "TypeError: x is not a function",
                    "source": "http://127.0.0.1:8080/app.js", "line": 12, "column": 3}},
]
MODEL_RESPONSE = [{
    "title": "Keep the filter selected", "description": "The filter may reset after navigation.",
    "steps_to_reproduce": ["Verify whether the selected filter resets after a reload"],
    "acceptance_criteria": ["The selected filter survives navigation"],
    "component": "filters", "priority": "medium", "evidence": "Untrusted model evidence claim",
    "event_indices": [1, 2], "desired_behavior": "Remember the selected filter",
    "questions": ["Should the filter survive a full browser restart?"],
}]


def generated_bundle(use_ai=False, events=None):
    """Exercise the real generator/exporter while replacing only the AI call."""
    with patch.object(tickets, "_ollama_decompose", return_value=json.dumps(MODEL_RESPONSE)) as model, \
            patch.object(integrations, "_request", side_effect=AssertionError("No delivery is authorized")) as network:
        generated = tickets.generate_drafts(copy.deepcopy(RECORDING), copy.deepcopy(events or EVENTS), use_ai=use_ai)
        bundle = integrations.export_bundle(copy.deepcopy(RECORDING), generated)
        network.assert_not_called()
        if use_ai:
            model.assert_called_once()
        else:
            model.assert_not_called()
    # Require standard JSON; NaN, infinities, and Python-only values cannot hide
    # behind a validator's interpretation of an in-memory object.
    return json.loads(json.dumps(bundle, allow_nan=False))


class BundleContractTests(unittest.TestCase):
    def test_schema_version_and_fixed_keys_match_both_real_export_modes(self):
        self.assertEqual(SCHEMA["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertEqual(SCHEMA["properties"]["schema_version"]["const"], integrations.SCHEMA_VERSION)
        for use_ai in (False, True):
            with self.subTest(mode="ai" if use_ai else "observed"):
                bundle = generated_bundle(use_ai)
                self.assertEqual(set(bundle), set(SCHEMA["required"]))
                self.assertEqual(set(bundle["tickets"][0]), set(SCHEMA["$defs"]["ticket"]["required"]))
                self.assertLessEqual(set(bundle["recording"]), set(SCHEMA["$defs"]["recording"]["properties"]))
                self.assertLessEqual(set(bundle["tickets"][0]["provenance"]), set(SCHEMA["$defs"]["provenance"]["properties"]))

    def test_real_modes_keep_observations_hypotheses_and_future_checks_separate(self):
        observed = generated_bundle(False)["tickets"][0]
        ai = generated_bundle(True)["tickets"][0]
        self.assertEqual(observed["hypothesis"], "")
        self.assertEqual(observed["suggested_verification_steps"], [])
        self.assertEqual(observed["provenance"]["origin"], "observed_evidence")
        self.assertIsNone(observed["provenance"]["model"])
        self.assertEqual(ai["steps_to_reproduce"], observed["steps_to_reproduce"])
        self.assertEqual(ai["hypothesis"], MODEL_RESPONSE[0]["description"])
        self.assertEqual(ai["suggested_verification_steps"], MODEL_RESPONSE[0]["steps_to_reproduce"])
        self.assertNotEqual(ai["evidence"], MODEL_RESPONSE[0]["evidence"])
        self.assertEqual(ai["provenance"]["origin"], "unverified_proposal")
        self.assertIs(ai["provenance"]["proposal_verified"], False)
        self.assertFalse(ai["provenance"]["media_analyzed"])

    def test_page_reported_failures_travel_as_observations_not_as_verified_defects(self):
        bundle = generated_bundle(False, FAILURE_EVENTS)
        ticket = bundle["tickets"][0]
        self.assertEqual(len(ticket["diagnostics"]), 2)
        self.assertEqual(ticket["diagnostics"][0]["kind"], "http_error")
        self.assertEqual(ticket["diagnostics"][0]["status"], 500)
        self.assertEqual(ticket["diagnostics"][0]["event_index"], 3)
        self.assertEqual(ticket["diagnostics"][1]["kind"], "uncaught_exception")
        self.assertEqual(ticket["diagnostics"][1]["event_index"], 4)
        self.assertEqual(ticket["provenance"]["diagnostic_count"], 2)
        self.assertFalse(ticket["provenance"]["proposal_verified"])
        self.assertFalse(ticket["execution_authorized"])
        # A capture without failures still carries the field, and it is empty.
        self.assertEqual(generated_bundle(False)["tickets"][0]["diagnostics"], [])

    def test_friction_hypotheses_travel_as_possibilities_not_as_confirmed_defects(self):
        events = EVENTS + [
            {"type": "click", "ts": 1002250, "url": "http://127.0.0.1:8080/",
             "target": {"tag": "button", "id": "save", "label": "Save"}},
            {"type": "click", "ts": 1002450, "url": "http://127.0.0.1:8080/",
             "target": {"tag": "button", "id": "save", "label": "Save"}},
            {"type": "click", "ts": 1002650, "url": "http://127.0.0.1:8080/",
             "target": {"tag": "button", "id": "save", "label": "Save"}},
        ]
        bundle = generated_bundle(False, events)
        friction = bundle["tickets"][0]["friction"]
        self.assertTrue(friction)
        for finding in friction:
            self.assertTrue(finding["hypothesis"])
            self.assertIn(finding["kind"], {"repeated_clicks", "non_control_click"})
            self.assertTrue(finding["event_indices"])
        self.assertFalse(bundle["tickets"][0]["provenance"]["proposal_verified"])
        self.assertFalse(bundle["tickets"][0]["execution_authorized"])

    def test_authority_is_literal_false_in_export_and_contract(self):
        bundle = generated_bundle(True)
        self.assertEqual(bundle["authority"], {"export_only": True, "requires_review": True, "execution_authorized": False})
        for location in (SCHEMA["properties"]["authority"], SCHEMA["$defs"]["ticket"]):
            self.assertIs(location["properties"]["execution_authorized"]["const"], False)
            self.assertIs(location["properties"]["requires_review"]["const"], True)
        self.assertIs(bundle["tickets"][0]["execution_authorized"], False)

    def test_contract_references_are_local_and_object_fields_are_closed(self):
        def walk(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    self.assertTrue(value["$ref"].startswith("#/$defs/"))
                    self.assertIn(value["$ref"].split("/")[-1], SCHEMA["$defs"])
                if value.get("type") == "object":
                    self.assertIs(value.get("additionalProperties"), False)
                for nested in value.values():
                    walk(nested)
            elif isinstance(value, list):
                for nested in value:
                    walk(nested)
        walk(SCHEMA)


@unittest.skipIf(Draft202012Validator is None, "Optional jsonschema validator unavailable; real Draft 2020-12 validation was not run")
class BundleSchemaValidationTests(unittest.TestCase):
    def setUp(self):
        self.validator = Draft202012Validator(SCHEMA)

    def assertValid(self, instance):
        errors = sorted(self.validator.iter_errors(instance), key=lambda error: str(error.json_path))
        self.assertEqual([], [f"{error.json_path}: {error.message}" for error in errors])

    def assertInvalid(self, instance):
        self.assertTrue(list(self.validator.iter_errors(instance)), "Malformed bundle unexpectedly passed validation")

    def test_schema_is_valid_draft_2020_12(self):
        Draft202012Validator.check_schema(SCHEMA)

    def test_real_observed_and_ai_exports_validate(self):
        for use_ai in (False, True):
            with self.subTest(mode="ai" if use_ai else "observed"):
                self.assertValid(generated_bundle(use_ai))

    def test_empty_bundle_and_minimal_legacy_ticket_validate(self):
        self.assertValid(integrations.export_bundle({"id": "legacy-record"}, {"tickets": []}))
        legacy = integrations.export_bundle({"id": "legacy-record"}, {"tickets": [{
            "id": "legacy-draft", "title": "Review this capture", "screenshots": [4.2],
            "evidence_refs": ["event-2", {"type": "event", "event_index": 2}],
            "provenance": {"origin": "model_proposal", "model": "local-legacy-model"},
        }]})
        self.assertValid(legacy)

    def test_authority_escalation_or_missing_review_fences_are_rejected(self):
        original = generated_bundle(True)
        for path, value in (("execution_authorized", True), ("requires_review", False), ("export_only", False)):
            with self.subTest(authority=path):
                changed = copy.deepcopy(original)
                changed["authority"][path] = value
                self.assertInvalid(changed)
        for field, value in (("execution_authorized", True), ("requires_review", False), ("status", "approved")):
            with self.subTest(ticket=field):
                changed = copy.deepcopy(original)
                changed["tickets"][0][field] = value
                self.assertInvalid(changed)

    def test_unknown_fields_raw_artifacts_and_missing_evidence_categories_are_rejected(self):
        original = generated_bundle(False)
        for scope, field in (("root", "events"), ("recording", "video_path"), ("ticket", "screenshots"), ("provenance", "raw_prompt")):
            with self.subTest(scope=scope):
                changed = copy.deepcopy(original)
                target = {"root": changed, "recording": changed["recording"], "ticket": changed["tickets"][0], "provenance": changed["tickets"][0]["provenance"]}[scope]
                target[field] = "private artifact"
                self.assertInvalid(changed)
        for field in ("hypothesis", "evidence", "suggested_verification_steps", "execution_authorized"):
            with self.subTest(missing=field):
                changed = copy.deepcopy(original)
                del changed["tickets"][0][field]
                self.assertInvalid(changed)

    def test_sensitive_url_schemes_and_local_evidence_paths_are_rejected(self):
        for url in ("file:///private/capture", "data:image/jpeg;base64,private", "https://user:secret@example.test/"):
            with self.subTest(url=url):
                changed = generated_bundle(False)
                changed["recording"]["source_url"] = url
                self.assertInvalid(changed)
        for reference in ("/private/capture", "~/capture", "file:///private/capture", "data:image/jpeg;base64,private", {"raw_event": {"value": "private"}}):
            with self.subTest(reference=reference):
                changed = generated_bundle(False)
                changed["tickets"][0]["evidence_refs"] = [reference]
                self.assertInvalid(changed)

    def test_bounds_and_numeric_field_types_are_enforced(self):
        for field, value in (("title", "x" * 1001), ("questions", ["question"] * 6), ("evidence_refs", ["event"] * 31), ("screenshot_timestamps", [0] * 21)):
            with self.subTest(field=field):
                changed = generated_bundle(False)
                changed["tickets"][0][field] = value
                self.assertInvalid(changed)
        for field, value in (("event_count", True), ("screenshot_count", -1), ("start_time", "1000")):
            with self.subTest(recording=field):
                changed = generated_bundle(False)
                changed["recording"][field] = value
                self.assertInvalid(changed)
        changed = generated_bundle(False)
        changed["tickets"][0]["evidence_refs"] = [{"event_index": 0}]
        self.assertInvalid(changed)
        changed = generated_bundle(False)
        changed["recording"]["id"] = "record\n"
        self.assertInvalid(changed)


if __name__ == "__main__":
    unittest.main()
