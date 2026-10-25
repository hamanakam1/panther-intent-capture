import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/monitor/status-model.js", import.meta.url), "utf8");
const {monitorView, liveView, STALE_AFTER_MS} = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const context = {connected: true, checkedAt: 1700000000000, now: 1700000000100};
const state = (status = "idle", values = {}) => ({ok: true, enabled: false, status, power: {state: "on"}, ...values});
const automatic = (status = "delivering", values = {}) => state("automation", {result: {id: "saved", eventCount: 4, screenshotCount: 1, ticketCount: 3, automationPolicy: {enabled: true}, automationCheckedAt: 1699999999000, automation: {status, ticket_count: 3, delivered_count: 1, stage: "delivery"}, ...values}});

test("fresh native runtime On is separated from idle capture and service health", () => {
  const view = monitorView(state(), context);
  assert.equal(view.title, "Panther is on");
  assert.equal(view.activity, "Idle");
  assert.match(view.runtimeHelp, /not a backend or destination health check/);
  assert.match(view.detail, /toolbar popup.*consent and start/);
  assert.equal(view.canStop, false);
});

test("initial, rejected, and stale confirmations never present cached On as live", () => {
  for (const ctx of [{}, {...context, connected: false}, {...context, now: context.checkedAt + STALE_AFTER_MS + 1}]) {
    const view = monitorView(automatic(), ctx);
    assert.equal(view.power, "unknown");
    assert.equal(view.activity, "Unknown");
    assert.equal(view.canCancel, false);
    assert.equal(view.canReview, false);
    assert.equal(view.offDisabled, false);
    assert.equal(view.historical, true);
  }
});

test("Off freezes old generating and delivering states while retaining evidence", () => {
  for (const old of [automatic(), state("generating", {result: {id: "saved", eventCount: 9, screenshotCount: 2}})]) {
    const view = monitorView({...old, power: {state: "off"}}, context);
    assert.equal(view.activity, "Idle");
    assert.equal(view.countsHeading, "Retained information");
    assert.equal(view.historical, true);
    assert.equal(view.canReview, false);
    assert.equal(view.canCancel, false);
    assert.equal(view.events, old.result.eventCount);
  }
});

test("new captures take precedence over prior result errors and receipts", () => {
  const old = automatic("blocked", {error: "old failure", cancelRequested: true});
  const view = monitorView({...old, status: "recording", session: {eventCount: 2, screenshotCount: 0}}, context);
  assert.equal(view.activity, "Capturing");
  assert.equal(view.events, 2);
  assert.equal(view.error, "");
  assert.equal(view.resultHistorical, true);
  assert.equal(view.canStop, true);
  assert.equal(view.canCancel, false);
});

test("power-paused capture and generation stay historical after explicit On", () => {
  for (const paused of [state("recording", {session: {powerPaused: true, eventCount: 8}}), automatic("generating", {powerPaused: true})]) {
    const view = monitorView(paused, context);
    assert.equal(view.activity, "Idle");
    assert.match(view.detail, /retained, not running/);
    assert.equal(view.canStop, false);
    assert.equal(view.canCancel, false);
    assert.equal(view.historical, true);
  }
});

test("all automatic stages have distinct truthful activity labels", () => {
  for (const [status, expected] of Object.entries({queued: "Generating", generating: "Generating", delivering: "Delivering", retry_wait: "Blocked", delivered: "Ready", blocked: "Blocked", cancelled: "Cancelled", unexpected: "Unknown"})) {
    const view = monitorView(automatic(status), context);
    assert.equal(view.activity, expected);
    assert.equal(view.delivered, 1);
    assert.equal(view.ticketTotal, 3);
    assert.equal(view.receiptCheckedAt, 1699999999000);
  }
});

test("partial cancellation retains receipts without claiming cancellation or fresh readback", () => {
  const view = monitorView(automatic("cancelled", {cancelRequested: true, error: "Unconfirmed cancellation"}), context);
  assert.equal(view.activity, "Blocked");
  assert.match(view.detail, /not yet confirmed/);
  assert.equal(view.cancelLabel, "Check cancellation");
  assert.equal(view.canCancel, true);
  assert.equal(view.delivered, 1);
});

test("capture and manual results distinguish saving, pending, generating and ready", () => {
  for (const [status, expected] of Object.entries({recording: "Capturing", saving: "Saving", pending: "Blocked"})) {
    assert.equal(monitorView(state(status, {session: {eventCount: 2}}), context).activity, expected);
  }
  assert.equal(monitorView(state("generating", {result: {id: "x"}}), context).activity, "Generating");
  const ready = monitorView(state("ready", {result: {id: "x", ticketCount: 2}}), context);
  assert.equal(ready.activity, "Ready");
  assert.equal(ready.drafts, 2);
  assert.match(ready.detail, /not been sent/);
});

test("Stop label follows the chosen session policy and cancellation withdrawal", () => {
  const input = state("recording", {session: {automation: {enabled: true}}});
  assert.equal(monitorView(input, context).stopLabel, "Stop & deliver tickets");
  assert.equal(monitorView(input, context).canCancel, true);
  input.session.automationWithdrawn = true;
  assert.equal(monitorView(input, context).stopLabel, "Stop & generate drafts");
  assert.equal(monitorView(input, context).canCancel, false);
});

test("model never exports raw goals, page URLs, event records or unsafe counts", () => {
  const view = monitorView(state("recording", {session: {goal: "PRIVATE GOAL", url: "https://private.test", events: ["PRIVATE EVENT"], eventCount: -1, screenshotCount: Infinity, error: "x".repeat(999)}}), context);
  assert.equal(view.events, 0);
  assert.equal(view.screenshots, 0);
  assert.equal(view.error.length, 600);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|private\.test/);
});

test("pending power controls cannot advertise active capture or disable Off during On", () => {
  const input = state("recording", {session: {eventCount: 2}});
  const starting = monitorView(input, {...context, pendingPower: "starting"});
  assert.equal(starting.title, "Turning on…");
  assert.equal(starting.activity, "Idle");
  assert.equal(starting.offDisabled, false);
  const stopping = monitorView(input, {...context, pendingPower: "stopping"});
  assert.equal(stopping.title, "Turning off…");
  assert.equal(stopping.canStop, false);
});

const liveCapture = () => state("recording", {enabled: true, session: {sessionId: "synthetic-session", eventCount: 3}, live: {sessionId: "synthetic-session", eventCount: 3, observedAt: context.now - 4000, summary: "Repeated visits to the settings page.", goal: "Find display settings", inferredIntent: "You may be trying to adjust the display.", page: {title: "Sample settings"}, recentEvents: [{seq: 1, ts: context.now - 5000, label: "Opened settings"}, {seq: 2, ts: context.now - 4000, label: "Selected display"}], patterns: [{title: "Repeated navigation", detail: "Two visits may indicate backtracking.", evidence: [1, 2], hypothesis: true}]}});

test("live projection separates observations, goal, tentative intent and event freshness", () => {
  const input = liveCapture();
  const live = liveView(input, monitorView(input, context), context.now);
  assert.equal(live.current, true);
  assert.equal(live.mode, "Live · rules");
  assert.match(live.freshness, /Last observed event: 4s ago/);
  assert.match(live.freshness, /No new events means no new observed activity/);
  assert.equal(live.goal, "Find display settings");
  assert.equal(live.intent, "You may be trying to adjust the display.");
  assert.deepEqual(live.patterns[0].evidence, [1, 2]);
});

test("saved, paused, stale, revoked and mismatched captures cannot become live understanding", () => {
  const original = liveCapture();
  const inputs = [
    {...original, status: "ready", session: null, result: {id: "saved"}},
    {...original, session: {...original.session, powerPaused: true}},
    {...original, enabled: false},
    {...original, session: {...original.session, sessionId: "another-session"}},
    {...original, power: {state: "off"}}
  ];
  for (const input of inputs) {
    const live = liveView(input, monitorView(input, context), context.now);
    assert.equal(live.current, false);
    assert.equal(live.mode, "Historical · rules");
    assert.match(live.freshness, /retained evidence, not current activity/);
  }
  assert.equal(liveView(original, monitorView(original, {...context, connected: false}), context.now).current, false);
});

test("live projection bounds rows and text and drops unsupported evidence references", () => {
  const input = liveCapture();
  input.live.summary = "x".repeat(2000);
  input.live.eventCount = 30;
  input.live.recentEvents = Array.from({length: 30}, (_, i) => ({seq: i + 1, label: "y".repeat(1000)}));
  input.live.patterns = Array.from({length: 9}, () => ({title: "Possible repeat", detail: "z".repeat(1000), evidence: [0, -1, 1, 999, "2", 3]}));
  const live = liveView(input, monitorView(input, context), context.now);
  assert.equal(live.summary.length, 600);
  assert.equal(live.recentEvents.length, 12);
  assert.equal(live.recentEvents[0].label.length, 240);
  assert.equal(live.patterns.length, 5);
  assert.equal(live.patterns[0].detail.length, 300);
  assert.deepEqual(live.patterns[0].evidence, [1, 3]);
  input.live.patterns = [{title: "Unsupported finding", evidence: [999]}];
  assert.equal(liveView(input, monitorView(input, context), context.now).patterns.length, 0);
});

test("idle does not manufacture activity or an interpretation", () => {
  const input = state();
  const live = liveView(input, monitorView(input, context), context.now);
  assert.equal(live.current, false);
  assert.equal(live.hasData, false);
  assert.match(live.summary, /not capturing/);
  assert.equal(live.intent, "");
  assert.deepEqual(live.recentEvents, []);
});

test("malformed retained projection entries cannot break the live window", () => {
  const input = liveCapture();
  input.live.recentEvents = [null, 4, "bad", [], {seq: 1, label: "Valid observation"}, {seq: 2, label: {bad: "data"}}];
  input.live.patterns = [null, "bad", {title: "Possible repeated action", evidence: [1]}];
  const live = liveView(input, monitorView(input, context), context.now);
  assert.equal(live.recentEvents.length, 2);
  assert.equal(live.recentEvents[1].label, "Page interaction");
  assert.equal(live.patterns.length, 1);
});

test("a user-stated goal is never relabeled as a tentative behavioral inference", () => {
  const input = liveCapture();
  input.live.inferredIntent = `User-stated goal: ${input.live.goal}`;
  const live = liveView(input, monitorView(input, context), context.now);
  assert.equal(live.goal, "Find display settings");
  assert.equal(live.intent, "");
});

test("behavioral inference keeps one uncertainty label instead of duplicate prefixes", () => {
  const input = liveCapture();
  input.live.inferredIntent = "Tentative interpretation from recent controls: The user may be adjusting display settings.";
  assert.equal(liveView(input, monitorView(input, context), context.now).intent, "The user may be adjusting display settings.");
});
