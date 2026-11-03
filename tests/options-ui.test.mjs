import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";

const optionsSource = (await readFile(new URL("../extension/options/options.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "");
const policySource = (await readFile(new URL("../extension/options/automation-state.js", import.meta.url), "utf8"))
  .replace(/^export /gm, "");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.hidden = false; this.disabled = false; this.value = "";
    this.children = []; this.listeners = {}; this.attributes = {};
    this.classList = {toggle() {}, remove() {}};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || "") + this.children.map(child => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ""; this.children = [...children]; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll(selector) {
    const tags = new Set(selector.split(",").map(tag => tag.trim().toUpperCase()));
    const result = [];
    const walk = node => {
      for (const child of node.children) {
        if (tags.has(child.tagName)) result.push(child);
        walk(child);
      }
    };
    walk(this); return result;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  async click() { if (!this.disabled) return this.listeners.click?.(); }
}

const capture = id => ({id, title: "Capture " + id, url: "http://example.test/", start_time: 1700000000,
  duration_ms: 1000, event_count: 1, screenshot_count: 0});
const drafts = id => ({mode: "observed", tickets: [{id: "draft-" + id, title: "Review " + id,
  description: "Observed action", acceptance_criteria: ["Verify the outcome"], steps_to_reproduce: ["Click"]}]});
const job = (status, extras = {}) => ({status, target_url: "http://127.0.0.1:8080",
  ticket_count: 1, delivered_count: 0, attempts: 1, deliveries: [], ...extras});

function fixture({initialJob = job("disabled"), initialStatus, screenshots = false, browserPower} = {}) {
  const elements = new Map(), responses = new Map(), calls = [], timers = new Map();
  let nextTimer = 0;
  const document = {
    visibilityState: "visible", listeners: {},
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement(tag) { return new Element(tag); },
    addEventListener(type, callback) { this.listeners[type] = callback; }
  };
  const respond = (method, path, handler) => responses.set(method + " " + path, handler);
  const recordings = [capture("a"), capture("b")];
  if (screenshots) recordings[0].screenshot_count = 1;
  respond("GET", "health", () => ({status: "ok"}));
  respond("GET", "recordings", () => ({recordings}));
  respond("GET", "integrations", () => ({destinations: [{ kind: "ticket-service", label: "Local ticket service",
    available: true, configured: true, state: "reachable", url: "http://127.0.0.1:8080", error: "" }]}));
  respond("GET", "integrations/ticket-service", () => ({ok: true}));
  for (const recording of recordings) {
    respond("GET", "recordings/" + recording.id, () => recording);
    respond("GET", "recordings/" + recording.id + "/events", () => ({events: [{type: "click"}]}));
    respond("GET", "recordings/" + recording.id + "/screenshots", () => ({screenshots: []}));
    respond("GET", "tickets/" + recording.id, () => drafts(recording.id));
    respond("GET", "automation/" + recording.id, () => initialJob);
  }
  if (initialStatus) respond("GET", "automation/a", initialStatus);
  const context = vm.createContext({
    BACKEND_ORIGIN: "http://127.0.0.1:7890", document, console, Date, URL, Blob, AbortSignal,
    location: {protocol: browserPower ? "chrome-extension:" : "http:", origin: "http://127.0.0.1:7890", href: "http://127.0.0.1:7890/?recording=a"},
    chrome: {runtime: {sendMessage: async (message) => {
      assert.equal(message.type, "extension.getPowerState");
      return browserPower();
    }}},
    history: {replaceState() {}}, confirm: () => true,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      const path = new URL(url).pathname.replace("/api/extension/", "");
      const call = {path, method: options.method, body: options.body ? JSON.parse(options.body) : undefined};
      calls.push(call);
      const handler = responses.get(call.method + " " + path);
      if (!handler) throw new Error("Unexpected request: " + call.method + " " + path);
      const body = await handler(call);
      return {ok: true, status: 200, async json() { return structuredClone(body); }};
    }
  });
  const ready = vm.runInContext(`(async () => {\n${policySource}\n${optionsSource}\n})()`, context);
  return {
    ready, calls, timers, respond,
    get(id) { return document.getElementById(id); },
    fields() { return document.getElementById("tickets").querySelectorAll("input, textarea"); },
    draftButton(label) { return document.getElementById("tickets").querySelectorAll("button").find(node => node.textContent === label); },
    async visibility(state = "visible") { document.visibilityState = state; document.listeners.visibilitychange(); await flush(); },
    async open(id) {
      const node = document.getElementById("recordings").children.find(item => item.textContent.startsWith("Capture " + id));
      assert.ok(node, "capture library contains " + id);
      await node.click(); await flush();
    }
  };
}

test("unconfigured delivery stays visible without disabling local draft review", async () => {
  const f = fixture();
  f.respond("GET", "integrations", () => ({destinations: [{ kind: "ticket-service", label: "Local ticket service",
    available: false, configured: false, state: "unconfigured", url: "", error: "not configured" }]}));
  await f.ready;
  assert.match(f.get("dashboardStatus").textContent, /not configured/);
  assert.match(f.get("dashboardStatus").textContent, /JSON export still work/);
  assert.ok(f.fields().length > 0);
  assert.ok(f.fields().every(field => !field.disabled));
});

test("actual review UI locks all draft controls until automation status is known", async () => {
  const status = deferred();
  const f = fixture({initialStatus: () => status.promise});
  await flush();
  assert.equal(f.get("generate").disabled, true);
  assert.ok(f.fields().length > 0);
  assert.ok(f.fields().every(field => field.disabled));
  status.resolve(job("disabled")); await f.ready;
  assert.equal(f.get("automationPanel").hidden, true);
  assert.ok(f.fields().every(field => !field.disabled));
});

test("extension review page does not contact any backend while Panther is off", async () => {
  const f = fixture({browserPower: () => ({ok: true, power: {state: "off"}})});
  await f.ready;
  assert.equal(f.calls.length, 0);
  assert.equal(f.get("generate").disabled, true);
  assert.match(f.get("message").textContent, /Panther is off/);
});

test("turning Panther off fences an already-open extension review page before the next mutation", async () => {
  let state = "on";
  const f = fixture({browserPower: () => ({ok: true, power: {state}})});
  await f.ready;
  assert.ok(f.calls.length > 0);
  const count = f.calls.length;
  state = "off";
  await f.get("generate").click();
  assert.equal(f.calls.length, count);
  assert.equal(f.get("generate").disabled, true);
  assert.match(f.get("message").textContent, /Panther is off/);
});

test("status failures preserve a stale label and lock actual review controls", async () => {
  const f = fixture(); await f.ready;
  f.respond("GET", "automation/a", () => { throw new Error("Connection lost"); });
  await f.visibility();
  assert.match(f.get("automationStatus").textContent, /Status unavailable.*Connection lost/);
  assert.equal(f.get("automationPanel").hidden, false);
  assert.equal(f.get("generate").disabled, true);
  assert.ok(f.fields().every(field => field.disabled));
  assert.equal(f.get("retryAutomation").hidden, true);
  assert.equal(f.get("cancelAutomation").hidden, true);
  assert.equal(f.timers.size, 1);
});

test("an older same-capture poll cannot overwrite a newer cancelled result", async () => {
  const f = fixture({initialJob: job("delivering")}); await f.ready;
  const old = deferred(); let requests = 0;
  f.respond("GET", "automation/a", () => ++requests === 1 ? old.promise : job("cancelled"));
  await f.visibility(); // First request remains outstanding.
  await f.visibility(); // A later refresh observes cancellation.
  assert.match(f.get("automationStatus").textContent, /cancelled/);
  old.resolve(job("delivering")); await flush();
  assert.match(f.get("automationStatus").textContent, /cancelled/);
  assert.equal(f.get("cancelAutomation").hidden, true);
  assert.equal(f.timers.size, 0);
});

test("a response for the previous capture cannot replace the selected capture status", async () => {
  const f = fixture({initialJob: job("delivering")}); await f.ready;
  const old = deferred();
  f.respond("GET", "automation/a", () => old.promise);
  f.respond("GET", "automation/b", () => job("disabled"));
  await f.visibility();
  await f.open("b");
  old.resolve(job("delivered", {delivered_count: 1})); await flush();
  assert.equal(f.get("captureTitle").textContent, "Capture b");
  assert.equal(f.get("automationPanel").hidden, true);
  assert.match(f.get("automationStatus").textContent, /Manual capture/);
});

test("status refresh must not re-enable a draft mutation still in flight", async () => {
  const f = fixture(); await f.ready;
  const save = deferred();
  f.respond("POST", "tickets/a/review", () => save.promise);
  const button = f.draftButton("Save draft edits");
  const pending = button.click(); await flush();
  assert.equal(button.disabled, true);
  await f.visibility();
  assert.equal(button.disabled, true);
  save.resolve({ok: true}); await pending;
  assert.equal(button.disabled, false);
});

test("manual regeneration locks existing edits until the generation request finishes", async () => {
  const f = fixture(); await f.ready;
  const generation = deferred();
  f.respond("POST", "tickets/a", () => generation.promise);
  const pending = f.get("generate").click(); await flush();
  assert.ok(f.fields().every(field => field.disabled));
  assert.equal(f.draftButton("Save draft edits").disabled, true);
  generation.resolve(drafts("a")); await pending;
  assert.ok(f.fields().every(field => !field.disabled));
});

test("hidden review pages do not start polling requests", async () => {
  const f = fixture({initialJob: job("delivering")}); await f.ready;
  const before = f.calls.length;
  await f.visibility("hidden");
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, before);
  await f.visibility("visible");
  assert.equal(f.calls.length, before + 1);
});

test("a failed cancel response refreshes status and discovers an acknowledged cancellation", async () => {
  const f = fixture({initialJob: job("delivering")}); await f.ready;
  f.respond("POST", "automation/a", call => {
    assert.deepEqual(call.body, {action: "cancel"});
    throw new Error("Cancel response was lost");
  });
  f.respond("GET", "automation/a", () => job("cancelled"));
  await f.get("cancelAutomation").click();
  assert.equal(f.calls.filter(call => call.path === "automation/a" && call.method === "POST").length, 1);
  assert.equal(f.calls.filter(call => call.path === "automation/a" && call.method === "GET").length, 2);
  assert.match(f.get("automationStatus").textContent, /cancelled/);
  assert.equal(f.get("cancelAutomation").hidden, true);
  assert.equal(f.get("generate").disabled, false);
  assert.equal(f.timers.size, 0);
});

test("failed cancel and status requests leave the UI stale, locked, and polling", async () => {
  const f = fixture({initialJob: job("delivering")}); await f.ready;
  f.respond("POST", "automation/a", () => { throw new Error("Cancel response was lost"); });
  f.respond("GET", "automation/a", () => { throw new Error("Status unavailable"); });
  await f.get("cancelAutomation").click();
  assert.match(f.get("automationStatus").textContent, /Status unavailable; last known state: delivering/);
  assert.doesNotMatch(f.get("automationStatus").textContent, /Remaining automatic delivery cancelled/);
  assert.equal(f.get("generate").disabled, true);
  assert.equal(f.get("cancelAutomation").hidden, true);
  assert.equal(f.timers.size, 1);
});

test("cancellation invalidates status requests started before the control action", async () => {
  const f = fixture({initialJob: job("delivering")}); await f.ready;
  const stale = deferred(), cancel = deferred(); let reads = 0;
  f.respond("GET", "automation/a", () => ++reads === 1 ? stale.promise : job("cancelled"));
  f.respond("POST", "automation/a", () => cancel.promise);
  await f.visibility();
  const pending = f.get("cancelAutomation").click();
  stale.resolve(job("delivered", {delivered_count: 1})); await flush();
  assert.doesNotMatch(f.get("automationStatus").textContent, /Automatic delivery finished/);
  assert.equal(f.get("cancelAutomation").disabled, true);
  cancel.resolve(job("cancelled")); await pending;
  assert.match(f.get("automationStatus").textContent, /cancelled/);
});

test("unavailable screenshot evidence does not hide automation status or cancellation", async () => {
  const f = fixture({initialJob: job("delivering"), screenshots: true});
  f.respond("GET", "recordings/a/screenshots", () => { throw new Error("Screenshot file unavailable"); });
  await f.ready;
  assert.match(f.get("screenshots").textContent, /Screenshot evidence unavailable/);
  assert.match(f.get("automationStatus").textContent, /Delivering/);
  assert.equal(f.get("cancelAutomation").hidden, false);
  assert.equal(f.get("cancelAutomation").disabled, false);
  assert.equal(f.timers.size, 1);
});

test("unredacted screenshot state is visible during review", async () => {
  const f = fixture({screenshots: true});
  f.respond("GET", "recordings/a/screenshots", () => ({
    screenshots: [{ts: 1700000000000, dataUrl: "data:image/jpeg;base64,ZmFrZQ=="}],
    redaction_status: "not_redacted",
    review_required: true,
  }));
  await f.ready;
  assert.match(f.get("screenshotPrivacyNotice").textContent, /not redacted/i);
  assert.equal(f.get("screenshotPrivacyNotice").hidden, false);
});

test("becoming hidden invalidates in-flight polling without scheduling background work", async () => {
  const f = fixture({initialJob: job("delivering")}); await f.ready;
  const stale = deferred();
  f.respond("GET", "automation/a", () => stale.promise);
  await f.visibility();
  await f.visibility("hidden");
  stale.resolve(job("delivered", {delivered_count: 1})); await flush();
  assert.doesNotMatch(f.get("automationStatus").textContent, /Automatic delivery finished/);
  assert.equal(f.timers.size, 0);
});
