"""Replay-plan contract tests: a proposal, never an execution."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import replay  # noqa: E402
import tickets  # noqa: E402

RECORDING = {
    "id": "replay-capture-1", "url": "http://127.0.0.1:8080/work-board?token=secret",
    "title": "Work board", "goal": "Save the selected filter", "capture_mode": "events",
    "start_time": 1000.25, "end_time": 1002.75,
}
EVENTS = [
    {"type": "navigation", "ts": 1000250, "url": "http://127.0.0.1:8080/work-board"},
    {"type": "click", "ts": 1000500, "url": "http://127.0.0.1:8080/work-board",
     "target": {"tag": "button", "label": "Save", "dataTicket": "M-4242"}},
    {"type": "click", "ts": 1000600, "url": "http://127.0.0.1:8080/work-board",
     "target": {"tag": "button", "label": "Save", "id": "save-button"}},
    {"type": "click", "ts": 1000700, "url": "http://127.0.0.1:8080/work-board",
     "target": {"tag": "div", "id": "filter-tile", "inert": True}},
    {"type": "change", "ts": 1000800, "url": "http://127.0.0.1:8080/work-board",
     "target": {"tag": "input", "id": "filter", "type": "text"}},
    {"type": "submit", "ts": 1000900, "url": "http://127.0.0.1:8080/work-board",
     "target": {"tag": "form", "id": "filter-form"}},
    {"type": "diagnostic", "ts": 1000950, "url": "http://127.0.0.1:8080/work-board",
     "diagnostic": {"kind": "http_error", "message": "A request returned HTTP 500",
                    "source": "http://127.0.0.1:8080/api/tickets", "status": 500}},
]


class ReplayPlanTests(unittest.TestCase):
    def plan(self):
        return replay.build_plan(dict(RECORDING), list(EVENTS))

    def test_the_plan_describes_the_recorded_path(self):
        plan = self.plan()
        self.assertEqual(plan["schema_version"], "1.0")
        self.assertEqual(plan["recording"]["id"], "replay-capture-1")
        actions = [step["action"] for step in plan["steps"]]
        self.assertEqual(actions, ["navigate", "click", "click", "click", "change", "submit"])
        self.assertEqual([step["index"] for step in plan["steps"]], [1, 2, 3, 4, 5, 6])

    def test_the_most_stable_handle_wins(self):
        selectors = {step["index"]: step["selector"] for step in self.plan()["steps"]}
        self.assertEqual(selectors[2]["strategy"], "test-id")
        self.assertEqual(selectors[2]["value"], "M-4242")
        self.assertEqual(selectors[2]["css"], '[data-ticket="M-4242"]')
        self.assertEqual(selectors[3]["strategy"], "id")
        self.assertEqual(selectors[3]["css"], "#save-button")
        self.assertTrue(selectors[2]["replayable"])

    def test_a_step_without_a_stable_handle_says_it_is_not_replayable(self):
        plan = replay.build_plan(dict(RECORDING), [
            {"type": "click", "ts": 1000500, "url": "http://127.0.0.1:8080/x", "target": {"tag": "div"}}])
        step = plan["steps"][-1]
        self.assertEqual(step["action"], "click")
        self.assertEqual(step["selector"]["strategy"], "none")
        self.assertFalse(step["replayable"])

    def test_a_changed_field_records_that_it_changed_and_not_its_value(self):
        step = [item for item in self.plan()["steps"] if item["action"] == "change"][0]
        self.assertFalse(step["replayable"])
        self.assertIn("never captured", step["note"])
        self.assertNotIn("value", step)

    def test_the_plan_carries_the_observations_and_the_friction(self):
        plan = self.plan()
        self.assertEqual(len(plan["observations"]), 1)
        self.assertEqual(plan["observations"][0]["status"], 500)
        self.assertTrue(plan["friction"])
        for finding in plan["friction"]:
            self.assertTrue(finding["hypothesis"])

    def test_the_plan_never_authorizes_execution(self):
        plan = self.plan()
        self.assertEqual(plan["authority"], {"export_only": True, "requires_review": True, "execution_authorized": False})
        self.assertFalse(plan["limits"]["executed_by_producer"])
        self.assertFalse(plan["limits"]["values_captured"])
        self.assertTrue(plan["limits"]["requires_review"])

    def test_the_plan_never_leaks_a_secret(self):
        serialized = json.dumps(self.plan())
        self.assertNotIn("secret", serialized)
        self.assertNotIn("token=", serialized)

    def test_a_rendered_script_is_a_proposal_and_carries_no_value(self):
        script = replay.render_playwright(self.plan())
        self.assertIn("Panther never runs it", script)
        self.assertIn('page.goto("http://127.0.0.1:8080/work-board")', script)
        self.assertIn("[data-ticket=", script)
        self.assertIn("M-4242", script)
        self.assertIn('page.locator("#save-button").click()', script)
        # A click on a non-control is still replayed: it is what the person did.
        self.assertIn('page.locator("#filter-tile").click()', script)
        # A field change is left out rather than guessed at.
        self.assertNotIn('page.locator("#filter")', script)
        # A form is submitted, not clicked.
        self.assertIn('page.locator("#filter-form").evaluate("form => form.requestSubmit()")', script)
        self.assertNotIn("secret", script)

    def test_a_step_without_a_handle_is_left_out_of_the_script(self):
        plan = replay.build_plan(dict(RECORDING), [
            {"type": "click", "ts": 1000500, "url": "http://127.0.0.1:8080/x", "target": {"tag": "div"}}])
        script = replay.render_playwright(plan)
        self.assertNotIn(".click()", script)

    def test_the_plan_is_bounded(self):
        events = [{"type": "click", "ts": 1000000 + index, "url": "http://127.0.0.1:8080/x",
                   "target": {"tag": "button", "id": f"b{index}"}} for index in range(500)]
        plan = replay.build_plan(dict(RECORDING), events)
        self.assertLessEqual(len(plan["steps"]), replay.MAX_STEPS)


if __name__ == "__main__":
    unittest.main()
