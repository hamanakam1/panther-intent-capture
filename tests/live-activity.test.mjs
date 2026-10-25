import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveActivity, sanitizeLiveActivity } from "../extension/shared/live-activity.js";

const origin = "https://example.test/";
const event = (type, ts = 1000, target = {}, url = origin) => ({ type, ts, url, target });
const session = (events = [], overrides = {}) => ({ consent: true, sessionId: "capture-1", title: "Example app", url: origin, goal: "", events, ...overrides });
const clicks = (target = { tag: "button", id: "save", label: "Save" }) => [1000, 2000, 3000].map((ts) => event("click", ts, target));

test("a page-reported failure is an observation with its own evidence, not a confirmed defect", () => {
  const out = buildLiveActivity(session([
    event("click", 1000, { tag: "button", label: "Save" }),
    { type: "diagnostic", ts: 1200, url: origin, diagnostic: { kind: "uncaught_exception", message: "TypeError: x is not a function", source: "https://example.test/app.js", line: 12 } },
    { type: "diagnostic", ts: 1300, url: origin, diagnostic: { kind: "http_error", message: "A request returned HTTP 500", source: "https://example.test/api/tickets", status: 500 } }
  ]));
  assert.deepEqual(out.recentEvents.map((item) => item.seq), [1, 2, 3]);
  assert.match(out.recentEvents[1].label, /^Page error: TypeError/);
  assert.match(out.recentEvents[2].label, /^Request failed: HTTP 500/);
  const pattern = out.patterns.find((item) => item.kind === "page_error");
  assert.ok(pattern);
  assert.deepEqual(pattern.evidence, [2, 3]);
  assert.equal(pattern.hypothesis, true);
  assert.match(pattern.detail, /not a verified defect/);
  assert.doesNotMatch(pattern.detail, /confirmed|reproduced/i);
  // A control the person actually used still describes the attempt, even
  // when a failure followed it.
  assert.match(out.inferredIntent, /save changes/);
  const onlyFailure = buildLiveActivity(session([
    { type: "diagnostic", ts: 1000, url: origin, diagnostic: { kind: "http_error", message: "A request returned HTTP 500", status: 500 } }
  ]));
  assert.match(onlyFailure.inferredIntent, /reported a failure/);
});

test("a page-reported failure never carries a control identity or raw page text", () => {
  const out = buildLiveActivity(session([
    { type: "diagnostic", ts: 1000, url: origin, diagnostic: { kind: "uncaught_exception", message: "boom", source: "https://example.test/app.js", private: "page text" } }
  ]));
  assert.equal(out.recentEvents[0].label, "Page error: boom");
  assert.deepEqual(Object.keys(out.recentEvents[0]).sort(), ["label", "seq", "ts", "type", "url"].sort());
  assert.doesNotMatch(JSON.stringify(out), /page text/);
});

test("a click on an element that is not a control is a hypothesis, not a confirmed defect", () => {
  const out = buildLiveActivity(session([
    event("click", 1000, { tag: "button", id: "save", label: "Save" }),
    { type: "click", ts: 1200, url: origin, target: { tag: "div", id: "tile", inert: true } }
  ]));
  const pattern = out.patterns.find((item) => item.kind === "non_control_click");
  assert.ok(pattern);
  assert.deepEqual(pattern.evidence, [2]);
  assert.equal(pattern.hypothesis, true);
  assert.match(pattern.detail, /never marked as a control/);
  assert.match(pattern.detail, /No failure is verified/);
});

test("absent or non-consented captures expose no activity", () => {
  for (const value of [null, undefined, {}, false, "capture", session([], { consent: false }), session([], { consent: "true" })]) assert.equal(buildLiveActivity(value), null);
});

test("empty consented captures have an explicit rules source and no invented observation", () => {
  const out = buildLiveActivity(session());
  assert.equal(out.source, "rules");
  assert.equal(out.eventCount, 0);
  assert.equal(out.observedAt, null);
  assert.equal(out.windowStartSeq, 0);
  assert.deepEqual(out.recentEvents, []);
  assert.deepEqual(out.patterns, []);
  assert.match(out.summary, /No page interactions/);
  assert.match(out.inferredIntent, /Waiting/);
});

test("projection is deterministic and does not mutate its source", () => {
  const input = session(clicks(), { screenshots: [{ dataUrl: "private-image" }] });
  const before = structuredClone(input);
  assert.deepEqual(buildLiveActivity(input), buildLiveActivity(input));
  assert.deepEqual(input, before);
});

test("event summaries explain navigation, clicks, changes and form submission without success claims", () => {
  const out = buildLiveActivity(session([
    event("navigation", 1000), event("click", 2000, { tag: "button", label: "Save" }),
    event("change", 3000, { tag: "input" }), event("submit", 4000, { tag: "form" })
  ]));
  assert.deepEqual(out.recentEvents.map((item) => item.seq), [1, 2, 3, 4]);
  assert.match(out.recentEvents[0].label, /^Visited/);
  assert.match(out.recentEvents[1].label, /Clicked “Save”/);
  assert.match(out.recentEvents[2].label, /value not captured/);
  assert.match(out.recentEvents[3].label, /result not observed/);
  assert.match(out.summary, /Outcomes are not verified/);
  assert.equal(out.observedAt, 4000);
});

test("projection emits only allowlisted keys and never raw event targets, typed values or screenshots", () => {
  const out = buildLiveActivity(session([event("change", 1000, { tag: "input", label: "private-label", value: "private-value", key: "private-key", nested: { value: "private-nested" } })], { screenshots: [{ dataUrl: "private-image" }], payload: "private-payload" }));
  assert.deepEqual(Object.keys(out).sort(), ["sessionId", "eventCount", "observedAt", "goal", "page", "recentEvents", "summary", "inferredIntent", "patterns", "source", "windowStartSeq"].sort());
  assert.deepEqual(Object.keys(out.recentEvents[0]).sort(), ["seq", "ts", "type", "label", "url"].sort());
  assert.doesNotMatch(JSON.stringify(out), /private-|"target"|"screenshots"|"payload"|"value"|"key"/);
});

test("projection sanitizes restored labels, title, goal, identifiers and URLs again", () => {
  const out = buildLiveActivity(session([event("click", 1000, { tag: "button", label: "Save token=raw-token user@example.test ghp_secretABC" }, "https://alice:password@example.test/token/raw-token?secret=secret-query#token-secret")], { sessionId: "token=session-secret", title: "user@example.test Bearer privatebearer", goal: "password=privatepass sk-secretABC" }));
  const serialized = JSON.stringify(out);
  assert.doesNotMatch(serialized, /raw-token|secret-query|token-secret|privatebearer|privatepass|session-secret|user@example|alice|ghp_secretABC|sk-secretABC/);
  assert.match(serialized, /REDACTED/);
  assert.equal(out.recentEvents[0].url, "https://example.test/token/REDACTED");
});

test("URL output additionally removes email addresses in path segments", () => {
  const out = buildLiveActivity(session([event("navigation", 1000, {}, "https://example.test/people/alice@example.test")]));
  assert.doesNotMatch(JSON.stringify(out), /alice@example/);
});

test("non-web URL schemes and malformed URLs are not exposed", () => {
  for (const value of ["javascript:alert(1)", "file:///private/data", "chrome://settings", "not a URL", "https://example.test/%broken/path"]) {
    const out = buildLiveActivity(session([event("navigation", 1000, {}, value)], { url: value }));
    assert.equal(out.page.url, "");
    assert.equal(out.recentEvents[0].url, "");
  }
});

test("all externally supplied display strings obey explicit limits", () => {
  const long = "ordinary words ".repeat(200);
  const longUrl = `https://example.test/${"path/".repeat(200)}`;
  const out = buildLiveActivity(session([event("click", 1000, { tag: "button", label: long }, longUrl)], { sessionId: long, title: long, goal: long }));
  assert.ok(out.sessionId.length <= 120);
  assert.ok(out.goal.length <= 300);
  assert.ok(out.page.title.length <= 120);
  assert.ok(out.page.url.length <= 500);
  assert.ok(out.recentEvents[0].url.length <= 500);
  assert.ok(out.recentEvents[0].label.length <= 140);
  assert.ok(out.summary.length <= 300);
  assert.ok(out.inferredIntent.length <= 300);
});

test("only the last twelve valid events from a bounded source window are returned", () => {
  const input = session(Array.from({ length: 100 }, (_, index) => event("navigation", index + 1)));
  const out = buildLiveActivity(input);
  assert.equal(out.eventCount, 100);
  assert.equal(out.recentEvents.length, 12);
  assert.deepEqual(out.recentEvents.map((item) => item.seq), Array.from({ length: 12 }, (_, index) => index + 89));
  assert.equal(out.windowStartSeq, 89);
});

test("unknown events are omitted without renumbering evidence", () => {
  const out = buildLiveActivity(session([event("click"), { type: "keydown", key: "private-key" }, null, event("submit", 4000)]));
  assert.equal(out.eventCount, 4);
  assert.deepEqual(out.recentEvents.map((item) => item.seq), [1, 4]);
  assert.doesNotMatch(JSON.stringify(out), /private-key|keydown/);
});

test("source window does not traverse old data or fill visible events from unlimited history", () => {
  const input = session([event("click"), ...Array.from({ length: 30 }, () => null)]);
  Object.defineProperty(input.events, "0", { get() { throw new Error("old event visited"); } });
  const out = buildLiveActivity(input);
  assert.ok(out);
  assert.equal(out.eventCount, 31);
  assert.deepEqual(out.recentEvents, []);
});

test("invalid timestamps become unknown and cannot manufacture repeated-click evidence", () => {
  const out = buildLiveActivity(session([NaN, Infinity, -1, "1000", null, 9e15].map((ts) => event("click", ts, { tag: "button", id: "save" }))));
  assert.ok(out.recentEvents.every((item) => item.ts === null));
  assert.equal(out.observedAt, null);
  assert.deepEqual(out.patterns, []);
});

test("epoch zero is a valid observed timestamp", () => {
  assert.equal(buildLiveActivity(session([event("click", 0)])).observedAt, 0);
});

test("three same-control clicks within ten seconds create a qualified hypothesis with evidence", () => {
  const out = buildLiveActivity(session(clicks()));
  assert.equal(out.patterns.length, 1);
  assert.equal(out.patterns[0].kind, "repeated_clicks");
  assert.equal(out.patterns[0].hypothesis, true);
  assert.deepEqual(out.patterns[0].evidence, [1, 2, 3]);
  assert.match(out.patterns[0].detail, /intentional repetition/);
  assert.match(out.patterns[0].detail, /No failure is verified/);
});

test("two clicks, slow clicks and matching labels without stable identities are not repetition evidence", () => {
  for (const input of [clicks().slice(0, 2), clicks().map((item, index) => ({ ...item, ts: index * 11000 })), clicks({ tag: "button", label: "Save" })]) {
    assert.deepEqual(buildLiveActivity(session(input)).patterns, []);
  }
});

test("same-label controls with different identities or page locations are not grouped", () => {
  const differentIds = clicks().map((item, index) => ({ ...item, target: { ...item.target, id: `save-${index}` } }));
  const differentPages = clicks().map((item, index) => ({ ...item, url: `${origin}view-${index}` }));
  assert.deepEqual(buildLiveActivity(session(differentIds)).patterns, []);
  assert.deepEqual(buildLiveActivity(session(differentPages)).patterns, []);
});

test("masked and truncated identifiers cannot collapse unrelated controls into a pattern", () => {
  for (const id of ["token=private-id", "word ".repeat(50), "person@example.test"]) {
    assert.deepEqual(buildLiveActivity(session(clicks({ tag: "button", id, label: "Save" }))).patterns, []);
    assert.deepEqual(buildLiveActivity(session(clicks({ tag: "button", id, dataTab: "settings", label: "Save" }))).patterns, []);
  }
});

test("semantic tab identities support repeated-control evidence without exposing raw targets", () => {
  const out = buildLiveActivity(session(clicks({ tag: "button", dataTab: "settings", label: "Settings" })));
  assert.equal(out.patterns[0].kind, "repeated_clicks");
  assert.doesNotMatch(JSON.stringify(out), /dataTab|"target"/);
});

test("A-B-A navigation produces a qualified three-event hypothesis", () => {
  const out = buildLiveActivity(session([event("navigation", 1000, {}, `${origin}a`), event("click", 1500), event("navigation", 2000, {}, `${origin}b`), event("navigation", 3000, {}, `${origin}a`)]));
  assert.equal(out.patterns[0].kind, "navigation_loop");
  assert.equal(out.patterns[0].hypothesis, true);
  assert.deepEqual(out.patterns[0].evidence, [1, 3, 4]);
  assert.match(out.patterns[0].detail, /ordinary comparison/);
});

test("same-page and forward-only navigation do not imply a loop", () => {
  for (const routes of [["a", "a", "a"], ["a", "b", "c"]]) {
    const out = buildLiveActivity(session(routes.map((route, index) => event("navigation", index * 1000, {}, `${origin}${route}`))));
    assert.deepEqual(out.patterns, []);
  }
});

test("repeated field changes expose a hypothesis without field values", () => {
  const out = buildLiveActivity(session([1000, 2000, 3000].map((ts) => event("change", ts, { tag: "input", id: "search", value: "private typed content", label: "private label" }))));
  assert.equal(out.patterns[0].kind, "repeated_changes");
  assert.deepEqual(out.patterns[0].evidence, [1, 2, 3]);
  assert.match(out.patterns[0].detail, /No field values/);
  assert.doesNotMatch(JSON.stringify(out), /private/);
});

test("every hypothesis references visible evidence and older patterns are dropped", () => {
  const out = buildLiveActivity(session([...clicks(), ...Array.from({ length: 13 }, (_, index) => event("navigation", 100000 + index, {}, `${origin}view-${index}`))]));
  assert.deepEqual(out.patterns, []);
  const mixed = buildLiveActivity(session([...clicks(), event("navigation", 4000, {}, `${origin}a`), event("navigation", 5000, {}, `${origin}b`), event("navigation", 6000, {}, `${origin}a`)]));
  const visible = new Set(mixed.recentEvents.map((item) => item.seq));
  assert.ok(mixed.patterns.every((pattern) => pattern.evidence.every((seq) => visible.has(seq))));
  assert.ok(mixed.patterns.length <= 3);
});

test("explicit user goals remain separate from interpretations of observed behavior", () => {
  const out = buildLiveActivity(session(clicks(), { goal: "Find an archived item" }));
  assert.equal(out.goal, "Find an archived item");
  assert.match(out.inferredIntent, /Tentative interpretation.*apply or save changes/);
  assert.doesNotMatch(out.inferredIntent, /archived item|User-stated goal/);
  const empty = buildLiveActivity(session([], { goal: "Find an archived item" }));
  assert.match(empty.inferredIntent, /Waiting for consented interactions/);
  assert.doesNotMatch(empty.inferredIntent, /archived item/);
});

test("recognized controls produce modest task interpretations, not completion claims", () => {
  const pairs = [["Search", /find or narrow/], ["Save", /apply or save/], ["Add item", /create or add/], ["Rename", /change an existing/], ["Archive", /remove or archive/], ["Settings", /adjust settings/]];
  for (const [label, expected] of pairs) {
    const out = buildLiveActivity(session([event("click", 1000, { tag: "button", label })]));
    assert.match(out.inferredIntent, expected);
    assert.match(out.inferredIntent, /Tentative interpretation/);
    assert.match(out.inferredIntent, /Outcome unknown/);
  }
});

test("unknown semantics do not invent a task and input labels cannot drive inference", () => {
  const out = buildLiveActivity(session([event("click", 1000, { tag: "input", label: "Delete all" })]));
  assert.match(out.inferredIntent, /not enough evidence/);
  assert.doesNotMatch(out.inferredIntent, /remove|archive/);
});

test("capture state and power changes do not rewrite observations or claim activity is live", () => {
  const input = session(clicks());
  const current = buildLiveActivity(input);
  assert.deepEqual(buildLiveActivity({ ...input, status: "pending", powerPaused: true }), current);
  assert.doesNotMatch(JSON.stringify(current), /currently recording|is live|AI understands|model inferred/);
});

test("malformed containers, accessors and coercion objects are safe and never invoked", () => {
  let invoked = 0;
  const poison = { toString() { invoked++; throw new Error("coercion"); } };
  const target = { tag: "button", id: poison, label: poison };
  Object.defineProperty(target, "href", { get() { invoked++; throw new Error("getter"); } });
  const input = session([null, [], poison, event("click", poison, target, poison)], { title: poison, goal: poison, sessionId: poison });
  Object.defineProperty(input, "url", { get() { invoked++; throw new Error("getter"); } });
  const out = buildLiveActivity(input);
  assert.ok(out);
  assert.equal(out.recentEvents.length, 1);
  assert.equal(out.page.title, "");
  assert.equal(out.page.url, "");
  assert.equal(invoked, 0);
  assert.equal(buildLiveActivity(session([], { events: { length: 99999999 } })).eventCount, 0);
});

test("revoked proxies fail closed", () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(buildLiveActivity(proxy), null);
  assert.equal(buildLiveActivity(session([], { events: proxy })), null);
});

test("interpretation does not consult the clock or make network requests", () => {
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  try {
    Date.now = () => { throw new Error("unexpected clock access"); };
    globalThis.fetch = () => { throw new Error("unexpected network request"); };
    const out = buildLiveActivity(session(clicks()));
    assert.equal(out.observedAt, 3000);
    assert.equal(out.source, "rules");
    assert.equal(out.patterns.length, 1);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test("cached projections retain valid bounded observations without mutation", () => {
  const input = buildLiveActivity(session(clicks()));
  const before = structuredClone(input);
  assert.deepEqual(sanitizeLiveActivity(input), input);
  assert.deepEqual(input, before);
});

test("invalid cached projection envelopes fail closed", () => {
  const valid = buildLiveActivity(session());
  for (const input of [null, undefined, [], "cached", {}, { ...valid, source: "local-ai" }, { ...valid, sessionId: "" }, { ...valid, sessionId: {} }, { ...valid, sessionId: "id ".repeat(30) }, ...[-1, 2001, 1.5, Infinity, "10", null].map(eventCount => ({ ...valid, eventCount }))]) {
    assert.equal(sanitizeLiveActivity(input), null);
  }
});

test("cached projection sanitization drops arbitrary fields and re-redacts display content", () => {
  const input = buildLiveActivity(session(clicks()));
  input.goal = "password=private-goal";
  input.summary = "Bearer private-summary";
  input.inferredIntent = "user@example.test";
  input.page = { title: "token=private-title", url: "https://user:pass@example.test/?token=private-url", body: "private-body" };
  input.target = { value: "private-target" };
  input.screenshots = ["private-image"];
  input.recentEvents[0] = { ...input.recentEvents[0], label: "Save ghp_privateABC", target: { key: "private-key" }, payload: "private-payload", url: "https://example.test/?q=private-query" };
  const out = sanitizeLiveActivity(input);
  assert.doesNotMatch(JSON.stringify(out), /private-|ghp_privateABC|user@example|"target"|"screenshots"|"payload"/);
  assert.equal(out.page.url, "https://example.test/");
  assert.deepEqual(Object.keys(out.recentEvents[0]).sort(), ["seq", "ts", "type", "label", "url"].sort());
});

test("cached projections bound and validate event sequences, timestamps, types and count", () => {
  const input = buildLiveActivity(session());
  input.eventCount = 20;
  input.recentEvents = Array.from({ length: 20 }, (_, index) => ({ seq: index + 1, ts: index + 1000, type: "click", label: "Clicked a button", url: origin }));
  input.recentEvents.push(null, { seq: 5000, type: "click", label: "invalid" }, { seq: 19, ts: Infinity, type: "click", label: "Most recent duplicate", url: origin }, { seq: 20, type: "keydown", label: "not captured" });
  input.observedAt = 9999999999;
  input.windowStartSeq = 999999;
  const out = sanitizeLiveActivity(input);
  assert.equal(out.recentEvents.length, 12);
  assert.equal(new Set(out.recentEvents.map(item => item.seq)).size, 12);
  assert.equal(out.recentEvents.find(item => item.seq === 19).ts, null);
  assert.equal(out.observedAt, 1019);
  assert.equal(out.windowStartSeq, 9);
  assert.ok(out.recentEvents.every(item => item.seq <= out.eventCount && item.type === "click"));
});

test("cached projection timestamps are derived only from retained valid event timestamps", () => {
  const input = buildLiveActivity(session(clicks()));
  input.observedAt = 9999999999;
  input.recentEvents.forEach(item => { item.ts = null; });
  assert.equal(sanitizeLiveActivity(input).observedAt, null);
  input.recentEvents[0].ts = 0;
  assert.equal(sanitizeLiveActivity(input).observedAt, 0);
});

test("cached patterns remain qualified and reference only existing visible evidence", () => {
  const input = buildLiveActivity(session(clicks()));
  const template = input.patterns[0];
  input.patterns = [null, { ...template, evidence: [1, 1, 3, 999, "2"], target: "private" }, { ...template, hypothesis: false }, { ...template, evidence: [2] }];
  const out = sanitizeLiveActivity(input);
  assert.equal(out.patterns.length, 2);
  assert.deepEqual(out.patterns[0].evidence, [1, 3]);
  assert.equal(out.patterns[0].hypothesis, true);
  assert.equal(out.patterns[0].target, undefined);
  assert.deepEqual(out.patterns[1].evidence, [2]);
  input.patterns = [{ ...template, kind: "verified_bug" }, { ...template, evidence: [999] }];
  assert.deepEqual(sanitizeLiveActivity(input).patterns, []);
});

test("cached projection malformed containers and accessors cannot invoke coercion or getters", () => {
  let invoked = 0;
  const input = buildLiveActivity(session(clicks()));
  Object.defineProperty(input, "summary", { get() { invoked++; throw new Error("getter"); } });
  const poison = { toString() { invoked++; throw new Error("coercion"); } };
  input.goal = poison;
  input.page = poison;
  input.recentEvents = [null, poison, ...input.recentEvents];
  input.patterns = [null, poison];
  const out = sanitizeLiveActivity(input);
  assert.ok(out);
  assert.equal(out.summary, "");
  assert.equal(out.goal, "");
  assert.equal(invoked, 0);
});

test("cached projection source traversal and display text are bounded", () => {
  const input = buildLiveActivity(session());
  const long = "ordinary text ".repeat(200);
  input.goal = long; input.summary = long; input.inferredIntent = long;
  input.page = { title: long, url: `https://example.test/${"path/".repeat(200)}` };
  input.eventCount = 100;
  input.recentEvents = Array.from({ length: 100 }, (_, index) => ({ seq: index + 1, ts: index, type: "click", label: long, url: origin }));
  Object.defineProperty(input.recentEvents, "0", { get() { throw new Error("old event visited"); } });
  const out = sanitizeLiveActivity(input);
  assert.ok(out);
  assert.ok(out.goal.length <= 300 && out.summary.length <= 300 && out.inferredIntent.length <= 300);
  assert.ok(out.page.title.length <= 120 && out.page.url.length <= 500);
  assert.equal(out.recentEvents.length, 12);
  assert.ok(out.recentEvents.every(item => item.label.length <= 140));
});
