import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const script = (await readFile(new URL("../extension/popup/popup.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(initial, target = "http://127.0.0.1:8080", options = {}) {
  const withPower = value => Object.hasOwn(value, "power") ? value : {...value, power: {state: "on", error: "", configured: true}};
  let state = withPower(initial);
  let interval;
  const calls = [];
  const fetches = [];
  const responses = new Map();
  const elements = {};
  const element = () => ({ hidden: false, disabled: false, checked: false, value: "", textContent: "", listeners: {}, children: [], addEventListener(type, fn) { this.listeners[type] = fn; }, replaceChildren(...nodes) { this.children = nodes; }, append(...nodes) {this.children.push(...nodes);} });
  const context = vm.createContext({
    BACKEND_ORIGIN: "http://127.0.0.1:7890", loadConsentLog: async () => [], Date, console, AbortSignal, URL, encodeURIComponent,
    document: { getElementById: (id) => elements[id] ||= element(), createElement: element },
    setInterval: (fn) => { interval = fn; },
    fetch: async (url) => { fetches.push(url); return options.fetch ? options.fetch(url) : { ok: true, json: async () => ({recordings: options.recordings || []}) }; }, confirm: () => true,
    chrome: options.noBrowser ? undefined : { tabs: { query: async () => options.page ? [options.page] : [{ id: 7, title: "Example page", url: "https://example.test/workflow" }] }, runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      sendMessage: async (message) => {
        calls.push(structuredClone(message));
        if (responses.has(message.type)) {
          const result = await responses.get(message.type)(message);
          return result?.status ? withPower(result) : result;
        }
        if (message.type === "extension.getAutomationTarget") return target
          ? { ok: true, destinations: [{ kind: "ticket-service", label: "Local ticket service", available: true, configured: true, state: "reachable", url: target, error: "" }] }
          : { ok: false, error: "Backend offline; destination unknown." };
        if (message.type === "extension.getPowerState") return {ok: true, power: structuredClone(state.power)};
        return structuredClone(state);
      }
    } }
  });
  vm.runInContext(script, context);
  return { elements, calls, fetches,
    respond(type, handler) { responses.set(type, handler); },
    setState(next) { state = withPower(next); },
    state(next) { state = withPower(next); interval(); },
    poll() { interval(); },
    async click(id) { if (!elements[id].disabled) await elements[id].listeners.click(); await flush(); }
  };
}

const recording = (screenshotsConsent = true) => ({
  ok: true, enabled: true, status: "recording",
  session: { eventCount: 3, screenshotCount: 1, startTime: 1700000000000, screenshotsConsent }, result: null
});

test("consent checkbox retains the user's selection while its change request is pending", async () => {
  const idle = { ok: true, enabled: false, status: "idle", session: null, result: null };
  const f = fixture(idle);
  await flush();
  let resolveConsent;
  f.respond("extension.setEnabled", () => new Promise((resolve) => { resolveConsent = resolve; }));
  f.elements.consent.checked = true;
  const pending = f.elements.consent.listeners.change();
  assert.equal(f.elements.consent.checked, true);
  assert.equal(f.elements.consent.disabled, true);
  f.state(idle); // An older status poll must not undo the pending selection.
  await flush();
  assert.equal(f.elements.consent.checked, true);
  const enabled = { ...idle, enabled: true };
  f.state(enabled);
  resolveConsent(enabled);
  await pending;
  assert.equal(f.elements.consent.checked, true);
  assert.equal(f.elements.consent.disabled, false);
});

test("failed consent changes restore the confirmed value and show the error", async () => {
  const f = fixture({ ok: true, enabled: true, status: "idle", session: null, result: null });
  await flush();
  let resolveConsent;
  f.respond("extension.setEnabled", () => new Promise((resolve) => { resolveConsent = resolve; }));
  f.elements.consent.checked = false;
  const pending = f.elements.consent.listeners.change();
  assert.equal(f.elements.consent.checked, false);
  resolveConsent({ ok: false, error: "Could not store consent." });
  await pending;
  assert.equal(f.elements.consent.checked, true);
  assert.equal(f.elements.consent.disabled, false);
  assert.equal(f.elements.error.textContent, "Could not store consent.");
});

test("reopened popup shows actual screenshot consent and resets it when the session finishes", async () => {
  const f = fixture(recording(true));
  await flush();
  assert.equal(f.elements.screenshots.checked, true);
  assert.equal(f.elements.screenshots.disabled, true);
  f.state({ ok: true, enabled: true, status: "ready", session: null, result: { id: "rec", eventCount: 3, ticketCount: 1 } });
  await flush();
  assert.equal(f.elements.screenshots.checked, false);
  assert.equal(f.elements.screenshots.disabled, false);
  await f.click("recordBtn");
  assert.equal(f.calls.find((call) => call.type === "extension.startRecording").screenshots, false);
});

test("pending capture exposes retry and discard while preserving its consent display", async () => {
  const state = recording(false); state.status = "pending"; state.session.error = "Backend unavailable; retry.";
  const f = fixture(state);
  await flush();
  assert.equal(f.elements.retryBtn.hidden, false);
  assert.equal(f.elements.discardBtn.hidden, false);
  assert.equal(f.elements.recordBtn.hidden, true);
  assert.equal(f.elements.stopBtn.hidden, true);
  assert.equal(f.elements.screenshots.checked, false);
  assert.equal(f.elements.error.textContent, "Backend unavailable; retry.");
  await f.click("retryBtn");
  assert.ok(f.calls.some((call) => call.type === "extension.retryUpload"));
});

test("popup reports generated draft count and surfaces generation-only retry", async () => {
  const f = fixture({ ok: true, enabled: true, status: "error", session: null, result: { id: "rec", eventCount: 3, ticketCount: 0, error: "Generation failed; recording saved." } });
  await flush();
  assert.equal(f.elements.generateBtn.hidden, false);
  assert.equal(f.elements.retryBtn.hidden, true);
  assert.equal(f.elements.reviewBtn.hidden, false);
  await f.click("generateBtn");
  assert.ok(f.calls.some((call) => call.type === "extension.retryGeneration"));
  f.state({ ok: true, enabled: true, status: "ready", session: null, result: { id: "rec", eventCount: 3, ticketCount: 2 } });
  await flush();
  assert.equal(f.elements.status.textContent, "Drafts ready");
  assert.match(f.elements.meta.textContent, /2 draft tickets/);
});

test("screenshot warnings remain visible independently of a successful save or generation", async () => {
  const state = recording(true); state.session.warning = "Screenshots unavailable; use the toolbar icon.";
  const f = fixture(state);
  await flush();
  assert.equal(f.elements.warning.hidden, false);
  assert.equal(f.elements.error.hidden, true);
  f.state({ ok: true, enabled: true, status: "ready", session: null, result: { id: "rec", eventCount: 3, ticketCount: 1, warning: state.session.warning } });
  await flush();
  assert.equal(f.elements.status.textContent, "Drafts ready");
  assert.equal(f.elements.warning.textContent, state.session.warning);
});

const policy = { enabled: true, consent: true, target_kind: "ticket-service", target_url: "http://127.0.0.1:8080", use_ai: false, max_tickets: 5 };
const automatic = (status = "queued") => ({ ok: true, enabled: true, status: "automation", session: null,
  result: { id: "rec", eventCount: 3, automationPolicy: { ...policy }, automationCheckedAt: 1700000000000,
    automation: { status, stage: "delivery", ticket_count: 2, delivered_count: 1 }, error: "" } });

test("automatic delivery and local AI are unchecked per-session opt-ins with exact visible destination", async () => {
  const f = fixture({ ok: true, enabled: true, status: "idle", session: null, result: null });
  await flush();
  assert.equal(f.elements.automation.checked, false);
  assert.equal(f.elements.automationAI.checked, false);
  assert.equal(f.elements.automationAI.disabled, true);
  assert.match(f.elements.automationTarget.textContent, /http:\/\/127.0.0.1:8080/);
  await f.click("recordBtn");
  assert.equal(f.calls.find((call) => call.type === "extension.startRecording").automation, undefined);
  f.elements.automation.checked = true;
  f.elements.automation.listeners.change();
  assert.equal(f.elements.automationAI.disabled, false);
  assert.equal(f.elements.automationAI.checked, false);
  f.elements.automationAI.checked = true;
  await f.click("recordBtn");
  assert.deepEqual(f.calls.filter((call) => call.type === "extension.startRecording").at(-1).automation, { ...policy, use_ai: true });
});

test("unknown destination disables automatic delivery without disabling manual capture", async () => {
  const f = fixture({ ok: true, enabled: true, status: "idle", session: null, result: null }, null);
  await flush();
  assert.equal(f.elements.automation.disabled, true);
  assert.equal(f.elements.recordBtn.disabled, false);
  assert.match(f.elements.automationTarget.textContent, /destination unknown/);
});

test("previous terminal delivery retains its receipt target while new consent shows and sends the new target", async () => {
  const target = "http://127.0.0.1:9999";
  const f = fixture(automatic("delivered"), target);
  await flush();
  assert.match(f.elements.automationTarget.textContent, /127.0.0.1:9999/);
  assert.doesNotMatch(f.elements.automationTarget.textContent, /fixed for this session/);
  assert.match(f.elements.meta.textContent, /127.0.0.1:8080/);
  await f.click("newCaptureBtn");
  assert.equal(f.elements.recordBtn.hidden, false);
  f.elements.automation.checked = true; f.elements.automation.listeners.change();
  await f.click("recordBtn");
  assert.equal(f.calls.find((call) => call.type === "extension.startRecording").automation.target_url, target);
});

test("active session policy stays frozen and Stop advertises delivery; completion resets session opt-ins", async () => {
  const state = recording(); state.session.automation = { ...policy, use_ai: true };
  const f = fixture(state, "http://127.0.0.1:9999"); await flush();
  assert.equal(f.elements.automation.checked, true);
  assert.equal(f.elements.automation.disabled, true);
  assert.equal(f.elements.automationAI.checked, true);
  assert.match(f.elements.automationTarget.textContent, /127.0.0.1:8080.*fixed/);
  assert.equal(f.elements.stopBtn.textContent, "Stop & deliver tickets");
  assert.equal(f.elements.cancelAutomationBtn.hidden, false);
  f.state(automatic()); await flush();
  assert.equal(f.elements.automation.checked, false);
  assert.equal(f.elements.automationAI.checked, false);
  assert.equal(f.elements.recordBtn.hidden, true);
  assert.equal(f.elements.generateBtn.hidden, true);
});

test("backend retry and cancellation controls are separate from upload/generation and disabled while busy", async () => {
  const f = fixture(automatic("retry_wait")); await flush();
  assert.equal(f.elements.retryAutomationBtn.hidden, false);
  assert.equal(f.elements.generateBtn.hidden, true);
  assert.equal(f.elements.retryBtn.hidden, true);
  let resolveCancel;
  f.respond("extension.cancelAutomation", () => new Promise((resolve) => { resolveCancel = resolve; }));
  const pending = f.elements.cancelAutomationBtn.listeners.click();
  assert.equal(f.elements.cancelAutomationBtn.disabled, true);
  f.state(automatic("retry_wait")); await flush();
  assert.equal(f.elements.cancelAutomationBtn.disabled, true);
  resolveCancel(automatic("cancelled")); await pending;
  assert.ok(f.calls.some((call) => call.type === "extension.cancelAutomation"));
});

test("status loss and partial cancellation retain historical receipt counts without claiming fresh ticket verification", async () => {
  const state = automatic("cancelled"); state.result.error = "Cancellation is unconfirmed."; state.result.cancelRequested = true;
  const f = fixture(state); await flush();
  assert.equal(f.elements.status.textContent, "Delivery status needs attention");
  assert.match(f.elements.meta.textContent, /1\/2 verified delivery receipts/);
  assert.match(f.elements.meta.textContent, /historical, not current ticket state/);
  assert.match(f.elements.meta.textContent, /Last status check/);
  assert.equal(f.elements.cancelAutomationBtn.textContent, "Check cancellation");
  assert.equal(f.elements.generateBtn.hidden, true);
  assert.equal(f.elements.recordBtn.hidden, true);
});

test("acknowledged missing-upload cancellation exposes discard but prevents a cancelled upload retry", async () => {
  const state = recording(); state.status = "pending";
  Object.assign(state.session, { automation: { ...policy }, automationWithdrawn: true, cancellationConfirmed: true, uploadAttempts: 1 });
  const f = fixture(state); await flush();
  assert.equal(f.elements.retryBtn.disabled, true);
  assert.equal(f.elements.discardBtn.disabled, false);
  assert.equal(f.elements.cancelAutomationBtn.hidden, true);
});

test("pending automatic upload offers read-only reconciliation separately from retry and cancellation", async () => {
  const state = recording(); state.status = "pending";
  Object.assign(state.session, { automation: { ...policy }, uploadAttempts: 1 });
  const f = fixture(state); await flush();
  assert.equal(f.elements.refreshAutomationBtn.hidden, false);
  assert.equal(f.elements.refreshAutomationBtn.textContent, "Check upload / delivery");
  await f.click("refreshAutomationBtn");
  assert.ok(f.calls.some((call) => call.type === "extension.refreshAutomation"));
  assert.equal(f.calls.some((call) => call.type === "extension.retryUpload"), false);
});

const powerState = (state, extra = {}) => ({state, error: "", configured: state === "on", ...extra});
const idlePower = (state = "off") => ({ok: true, enabled: false, status: "idle", session: null, result: null, power: powerState(state)});

test("status-window launch is available while Off and never turns on or starts capture", async () => {
  const f = fixture(idlePower()); await flush();
  assert.equal(f.elements.monitorBtn.disabled, false);
  await f.click("monitorBtn");
  assert.equal(f.calls.filter(call => call.type === "extension.openMonitor").length, 1);
  assert.ok(f.calls.every(call => ["extension.getStatus", "extension.openMonitor"].includes(call.type)));
  assert.equal(f.fetches.length, 0);
  assert.equal(f.elements.powerStatus.textContent, "Panther is off");
});

test("status-window failures are separate from power and never disable Off", async () => {
  const f = fixture(idlePower("on")); await flush();
  f.respond("extension.openMonitor", () => ({ok: false, monitorError: "Window creation failed."}));
  await f.click("monitorBtn");
  assert.match(f.elements.monitorError.textContent, /Window creation failed/);
  assert.equal(f.elements.monitorError.hidden, false);
  assert.equal(f.elements.powerStatus.textContent, "Panther is on");
  assert.equal(f.elements.turnOffBtn.disabled, false);
  assert.equal(f.elements.monitorBtn.disabled, false);
});

test("pending status-window opening deduplicates clicks and cannot delay Off", async () => {
  const f = fixture(idlePower("on")); await flush();
  let finishWindow;
  f.respond("extension.openMonitor", () => new Promise(resolve => { finishWindow = resolve; }));
  f.respond("extension.turnOff", () => {
    f.setState(idlePower()); return {ok: true, power: powerState("off")};
  });
  const opening = f.elements.monitorBtn.listeners.click(); await flush();
  assert.equal(f.elements.monitorBtn.disabled, true);
  assert.equal(f.elements.turnOffBtn.disabled, false);
  await f.elements.monitorBtn.listeners.click();
  await f.click("turnOffBtn");
  finishWindow({ok: true, power: powerState("on")}); await opening;
  assert.equal(f.elements.powerStatus.textContent, "Panther is off");
  assert.equal(f.calls.filter(call => call.type === "extension.openMonitor").length, 1);
});

test("background automatic-window error stays visible without claiming startup failed", async () => {
  const f = fixture({...idlePower("on"), monitorError: "Status window unavailable; reopen from the popup."});
  await flush();
  assert.equal(f.elements.powerStatus.textContent, "Panther is on");
  assert.match(f.elements.monitorError.textContent, /Status window unavailable/);
  assert.equal(f.elements.powerError.hidden, true);
  assert.equal(f.elements.turnOffBtn.disabled, false);
});

test("opening and polling an off popup never starts a helper or contacts the backend", async () => {
  const f = fixture(idlePower()); await flush();
  f.poll(); f.poll(); await flush();
  assert.equal(f.elements.powerStatus.textContent, "Panther is off");
  assert.equal(f.elements.turnOnBtn.hidden, false);
  assert.equal(f.elements.turnOffBtn.hidden, true);
  assert.equal(f.elements.consent.disabled, true);
  assert.equal(f.elements.recordBtn.disabled, true);
  assert.equal(f.elements.automation.disabled, true);
  assert.equal(f.fetches.length, 0);
  assert.ok(f.calls.every(call => call.type === "extension.getStatus"));
  assert.match(f.elements.automationTarget.textContent, /No backend request is made while off/);
});

test("Turn on starts only the runtime, checks its destination once, and requires fresh capture consent", async () => {
  const f = fixture({...idlePower(), enabled: true}); await flush();
  f.respond("extension.turnOn", () => {
    f.setState(idlePower("on"));
    return {ok: true, power: powerState("on")};
  });
  await f.click("turnOnBtn");
  assert.equal(f.elements.powerStatus.textContent, "Panther is on");
  assert.equal(f.elements.consent.checked, false);
  assert.equal(f.elements.consent.disabled, false);
  assert.equal(f.elements.recordBtn.disabled, true);
  assert.equal(f.elements.turnOffBtn.disabled, false);
  assert.equal(f.calls.filter(call => call.type === "extension.turnOn").length, 1);
  assert.equal(f.calls.filter(call => call.type === "extension.getAutomationTarget").length, 1);
  assert.equal(f.calls.some(call => call.type === "extension.startRecording"), false);
  assert.equal(f.fetches.length, 2); // Read-only health and recent captures, only after explicit On.
  f.poll(); f.poll(); await flush();
  assert.equal(f.fetches.length, 2);
  assert.match(f.elements.powerHelp.textContent, /Stop & deliver leaves Panther on/);
});

test("missing native helper shows actionable setup state and the exact extension ID without backend probing", async () => {
  const f = fixture(idlePower()); await flush();
  const power = powerState("error", {configured: false, error: "Native helper unavailable. Register com.panther.intent_capture for this browser."});
  f.respond("extension.turnOn", () => {
    f.setState({...idlePower(), power});
    return {ok: false, power};
  });
  await f.click("turnOnBtn");
  assert.equal(f.elements.setupNeeded.hidden, false);
  assert.equal(f.elements.extensionId.textContent, "abcdefghijklmnopabcdefghijklmnop");
  assert.match(f.elements.powerError.textContent, /com\.panther\.intent_capture/);
  assert.equal(f.elements.recordBtn.disabled, true);
  assert.equal(f.elements.turnOffBtn.disabled, false);
  assert.equal(f.fetches.length, 0);
  assert.equal(f.calls.some(call => call.type === "extension.getAutomationTarget"), false);
});

test("Turn off stays enabled during generation and ignores the superseded generation response", async () => {
  const old = {ok: true, enabled: true, status: "error", session: null,
    result: {id: "rec", eventCount: 3, ticketCount: 0, error: "Retry generation"}};
  const f = fixture(old); await flush();
  let finishGeneration;
  f.respond("extension.retryGeneration", () => new Promise(resolve => { finishGeneration = resolve; }));
  f.respond("extension.turnOff", () => {
    f.setState({...old, enabled: false, power: powerState("off")});
    return {ok: true, power: powerState("off")};
  });
  const generation = f.elements.generateBtn.listeners.click(); await flush();
  assert.equal(f.elements.generateBtn.disabled, true);
  assert.equal(f.elements.turnOffBtn.disabled, false);
  await f.click("turnOffBtn");
  finishGeneration({...old, status: "ready", result: {...old.result, ticketCount: 1, error: ""}});
  await generation;
  assert.equal(f.elements.powerStatus.textContent, "Panther is off");
  assert.equal(f.elements.status.textContent, "Saved information");
  assert.equal(f.elements.generateBtn.disabled, true);
  assert.equal(f.calls.filter(call => call.type === "extension.turnOff").length, 1);
  assert.equal(f.calls.filter(call => call.type === "extension.startRecording").length, 0);
});

test("Turn off during capture does not invoke Stop-and-deliver and preserves the displayed unsaved count", async () => {
  const state = recording(); state.session.automation = {...policy};
  const f = fixture(state); await flush();
  f.respond("extension.turnOff", () => {
    f.setState({...state, enabled: false, status: "pending", power: powerState("off")});
    return {ok: true, power: powerState("off")};
  });
  await f.click("turnOffBtn");
  assert.match(f.elements.meta.textContent, /3 events/);
  assert.equal(f.elements.status.textContent, "Capture retained");
  assert.equal(f.elements.retryBtn.disabled, true);
  assert.equal(f.elements.stopBtn.hidden, true);
  assert.equal(f.calls.some(call => call.type === "extension.stopRecording"), false);
  assert.equal(f.calls.some(call => call.type === "extension.retryUpload"), false);
});

test("Turn off can preempt starting and a late Turn-on response cannot reactivate the popup", async () => {
  const f = fixture(idlePower()); await flush();
  let finishOn;
  f.respond("extension.turnOn", () => new Promise(resolve => { finishOn = resolve; }));
  f.respond("extension.turnOff", () => ({ok: true, power: powerState("off")}));
  const starting = f.elements.turnOnBtn.listeners.click(); await flush();
  assert.equal(f.elements.powerStatus.textContent, "Turning Panther on…");
  assert.equal(f.elements.turnOffBtn.hidden, false);
  assert.equal(f.elements.turnOffBtn.disabled, false);
  await f.click("turnOffBtn");
  finishOn({ok: true, power: powerState("on")}); await starting;
  assert.equal(f.elements.powerStatus.textContent, "Panther is off");
  assert.equal(f.elements.recordBtn.disabled, true);
  assert.equal(f.fetches.length, 0);
});

test("a status poll begun before Turn off cannot restore stale On state", async () => {
  const f = fixture(idlePower("on")); await flush();
  let finishPoll, reads = 0;
  f.respond("extension.getStatus", () => ++reads === 1 ? new Promise(resolve => { finishPoll = resolve; }) : idlePower());
  f.respond("extension.turnOff", () => ({ok: true, power: powerState("off")}));
  f.poll(); await flush();
  await f.click("turnOffBtn");
  finishPoll({...idlePower("on"), enabled: true}); await flush();
  assert.equal(f.elements.powerStatus.textContent, "Panther is off");
  assert.equal(f.elements.consent.checked, false);
  assert.equal(f.elements.recordBtn.disabled, true);
});

test("destination discovery finishing after Turn off cannot enable automation", async () => {
  const f = fixture(idlePower("on"));
  let finishTarget;
  f.respond("extension.getAutomationTarget", () => new Promise(resolve => { finishTarget = resolve; }));
  await flush();
  f.respond("extension.turnOff", () => {
    f.setState(idlePower()); return {ok: true, power: powerState("off")};
  });
  await f.click("turnOffBtn");
  finishTarget({ok: true, destinations: [{ kind: "ticket-service", label: "Local ticket service", available: true, configured: true, state: "reachable", url: "http://127.0.0.1:9999", error: "" }]}); await flush();
  assert.equal(f.elements.automation.disabled, true);
  assert.doesNotMatch(f.elements.automationTarget.textContent, /9999/);
  assert.equal(f.elements.backendBanner.hidden, true);
});

test("off and unknown-power states block mutation handlers and retain historical delivery information", async () => {
  for (const power of [powerState("off"), null, {state: "unexpected"}]) {
    const f = fixture({...automatic("retry_wait"), power}); await flush();
    for (const id of ["retryAutomationBtn", "cancelAutomationBtn", "generateBtn", "retryBtn", "recordBtn", "refreshAutomationBtn"]) {
      assert.equal(f.elements[id].disabled, true, id);
      await f.elements[id].listeners.click();
    }
    assert.match(f.elements.meta.textContent, /1\/2 verified delivery receipts/);
    assert.match(f.elements.meta.textContent, /historical/);
    assert.equal(f.calls.some(call => !["extension.getStatus"].includes(call.type)), false);
    assert.equal(f.fetches.length, 0);
  }
});

test("loss of runtime status fails closed without hiding the independent Off action", async () => {
  const f = fixture({...idlePower("on"), enabled: true}); await flush();
  f.respond("extension.getStatus", () => { throw new Error("Worker unavailable"); });
  f.poll(); await flush();
  assert.equal(f.elements.powerStatus.textContent, "Panther needs attention");
  assert.equal(f.elements.consent.checked, false);
  assert.equal(f.elements.recordBtn.disabled, true);
  assert.equal(f.elements.turnOffBtn.hidden, false);
  assert.equal(f.elements.turnOffBtn.disabled, false);
  assert.match(f.elements.powerError.textContent, /Worker unavailable/);
});

test("power controls precede capture controls and setup links only to the documented repository page", async () => {
  const html = await readFile(new URL("../extension/popup/popup.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('id="turnOffBtn"') < html.indexOf('id="recordBtn"'));
  assert.match(html, /https:\/\/github\.com\/hamanakam1\/panther-intent-capture\/blob\/main\/docs\/BROWSER_CONTROL\.md/);
  assert.match(html, /Stop saves or delivers this session and leaves Panther on/);
  assert.match(html, /Turning Panther off stops capture, cancels remaining automatic delivery, and preserves unsaved events/);
  const css = await readFile(new URL("../extension/popup/popup.css", import.meta.url), "utf8");
  assert.match(css, /\.topbar\s*\{[^}]*position:\s*sticky/);
});

test("dashboard shows session counts with current versus historical meaning", async () => {
  const state = recording(true); state.session.url = "https://example.test/settings?private=ignored";
  const f = fixture(state); await flush();
  assert.equal(f.elements.eventMetric.textContent, "3");
  assert.equal(f.elements.screenshotMetric.textContent, "1");
  assert.equal(f.elements.draftMetric.textContent, "—");
  assert.equal(f.elements.metricScope.textContent, "CURRENT SESSION");
  assert.equal(f.elements.pageTitle.textContent, "example.test/settings");
  assert.equal(f.elements.captureSetup.hidden, true);
  assert.match(f.elements.nextTitle.textContent, /Work through/);
  f.state({...state, power: powerState("off")}); await flush();
  assert.equal(f.elements.eventMetric.textContent, "3");
  assert.match(f.elements.metricScope.textContent, /NOT LIVE/);
  assert.match(f.elements.sessionNote.textContent, /historical/);
  assert.match(f.elements.pageDetail.textContent, /not running/);
});

test("dashboard blocks browser-internal pages with an actionable explanation", async () => {
  const f = fixture({...idlePower("on"), enabled: true}, undefined, {page: {id: 7, title: "Settings", url: "chrome://settings"}}); await flush();
  assert.equal(f.elements.recordBtn.disabled, true);
  assert.match(f.elements.nextTitle.textContent, /regular webpage/);
  assert.match(f.elements.pageDetail.textContent, /cannot be captured/);
  await f.elements.recordBtn.listeners.click();
  assert.equal(f.calls.filter(call => call.type === "extension.startRecording").length, 0);
});

test("dashboard loads only three recent captures and opens review without capture authority", async () => {
  const recordings = Array.from({length: 4}, (_, i) => ({id: `capture/${i}`, title: `Saved <capture> ${i}`, event_count: i, start_time: 1700000000}));
  const f = fixture(idlePower("on"), undefined, {recordings}); await flush();
  assert.equal(f.elements.recentCaptures.children.length, 3);
  const first = f.elements.recentCaptures.children[0];
  assert.equal(first.href, "../options/options.html?recording=capture%2F0");
  assert.equal(first.children[0].textContent, "Saved <capture> 0");
  assert.equal(first.target, "_blank");
  assert.ok(f.calls.every(call => ["extension.getStatus", "extension.getAutomationTarget"].includes(call.type)));
  assert.match(f.elements.helperHealth.textContent, /connected/);
});

test("recent-capture response arriving after Off cannot restore backend information", async () => {
  let resolveRecent;
  const pending = new Promise(resolve => {resolveRecent = resolve;});
  const f = fixture(idlePower("on"), undefined, {fetch: async url => url.endsWith("/recordings") ? pending : {ok: true}}); await flush();
  f.state(idlePower("off")); await flush();
  resolveRecent({ok: true, json: async () => ({recordings: [{id: "old", title: "Old response"}]})}); await flush();
  assert.equal(f.elements.recentCaptures.children.length, 0);
  assert.match(f.elements.recentStatus.textContent, /No service request/);
});

test("unavailable recent captures name a recovery action without claiming an empty store", async () => {
  const f = fixture(idlePower("on"), undefined, {fetch: async url => ({ok: !url.endsWith("/recordings")})}); await flush();
  assert.match(f.elements.recentStatus.textContent, /unavailable.*Refresh/);
  assert.doesNotMatch(f.elements.recentStatus.textContent, /No saved captures/);
});

test("legacy worker target is only a configured ticket service, with reachability unconfirmed", async () => {
  const f = fixture(idlePower("on"));
  f.respond("extension.getAutomationTarget", () => ({ok: true, url: "http://127.0.0.1:8080"})); await flush();
  assert.equal(f.elements.automationDestination.children.length, 1);
  assert.equal(f.elements.automationDestination.children[0].value, "ticket-service");
  assert.match(f.elements.automationDestination.children[0].textContent, /reachability not checked/);
  assert.match(f.elements.automationTarget.textContent, /reachability not checked/);
  assert.equal(f.elements.automation.checked, false);
  assert.equal(f.elements.automationAI.checked, false);
  assert.equal(f.calls.filter(call => /startRecording|setEnabled|turnOn/.test(call.type)).length, 0);
});

test("malformed or credentialed legacy destination cannot enable automatic delivery", async () => {
  for (const url of ["javascript:alert(1)", "http://secret:password@127.0.0.1:8080", "not a URL"]) {
    const f = fixture(idlePower("on"));
    f.respond("extension.getAutomationTarget", () => ({ok: true, url})); await flush();
    assert.equal(f.elements.automation.disabled, true);
    assert.equal(f.elements.automation.checked, false);
  }
});

test("ordinary HTTP popup preview fails closed without browser or backend requests", async () => {
  const f = fixture(idlePower("off"), undefined, {noBrowser: true}); await flush();
  assert.equal(f.elements.previewNotice.hidden, false);
  assert.equal(f.elements.powerStatus.textContent, "Web preview only");
  assert.equal(f.elements.recordBtn.disabled, true);
  assert.equal(f.elements.turnOnBtn.disabled, true);
  assert.equal(f.elements.monitorBtn.disabled, true);
  assert.equal(f.elements.refreshStatus.disabled, true);
  assert.match(f.elements.nextDetail.textContent, /cannot read browser status/);
  assert.equal(f.calls.length, 0); assert.equal(f.fetches.length, 0);
});

test("popup document has a stable intrinsic width and ordinary labels cannot break every letter", async () => {
  const html = await readFile(new URL("../extension/popup/popup.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../extension/popup/popup.css", import.meta.url), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(css, /html\{[^}]*width:400px;min-width:400px;writing-mode:horizontal-tb/);
  assert.match(css, /body\{[^}]*width:400px;min-width:400px;[^}]*word-break:normal;overflow-wrap:normal/);
  assert.doesNotMatch(css, /max-width:\s*100vw|word-break:\s*break-all/);
  assert.match(css, /\.btn\{[^}]*word-break:normal;white-space:normal/);
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.ok(html.indexOf('id="turnOffBtn"') < html.indexOf('id="recordBtn"'));
});

test("terminal delivery leaves the next capture goal and consent visible", async () => {
  for (const status of ["delivered", "cancelled", "blocked"]) {
    const f = fixture(automatic(status)); await flush();
    assert.equal(f.elements.newCaptureBtn.hidden, false, status);
    assert.equal(f.elements.captureSetup.hidden, true, status);
    await f.click("newCaptureBtn");
    assert.equal(f.elements.recordBtn.hidden, false, status);
    assert.equal(f.elements.captureSetup.hidden, false, status);
    assert.equal(f.elements.goal.disabled, false, status);
    assert.equal(f.elements.consent.disabled, false, status);
    assert.equal(f.elements.draftMetric.textContent, "2", status);
  }
});

test("off overview hides inactive setup but preserves retained recovery and independent power controls", async () => {
  const f = fixture({...recording(), status: "pending", power: powerState("off")}); await flush();
  assert.equal(f.elements.captureSetup.hidden, true);
  assert.equal(f.elements.recordBtn.hidden, true);
  assert.equal(f.elements.retryBtn.hidden, false);
  assert.equal(f.elements.retryBtn.disabled, true);
  assert.equal(f.elements.discardBtn.hidden, false);
  assert.equal(f.elements.turnOnBtn.hidden, false);
  assert.match(f.elements.metricScope.textContent, /RETAINED/);
});

test("recording keeps the supplied captured goal visible without using a new draft goal", async () => {
  const state = recording(false); state.session.goal = "Keep the selected filter after Save.";
  const f = fixture(state); await flush();
  f.elements.goal.value = "An unrelated unsent goal";
  f.poll(); await flush();
  assert.equal(f.elements.goalContext.hidden, false);
  assert.equal(f.elements.capturedGoal.textContent, state.session.goal);
  assert.equal(f.elements.captureSetup.hidden, true);
  const legacy = recording(false); f.state(legacy); await flush();
  assert.match(f.elements.capturedGoal.textContent, /worker did not supply/);
  assert.doesNotMatch(f.elements.capturedGoal.textContent, /unrelated unsent/);
});

test("saved review stays primary until another capture is explicitly prepared", async () => {
  const f = fixture({ok:true,enabled:true,status:"ready",power:powerState("on"),result:{id:"saved",eventCount:8,ticketCount:1,goal:"Check the navigation label."},session:null}); await flush();
  assert.equal(f.elements.recordBtn.hidden, true);
  assert.equal(f.elements.captureSetup.hidden, true);
  assert.equal(f.elements.reviewBtn.hidden, false);
  assert.equal(f.elements.capturedGoal.textContent, "Check the navigation label.");
  await f.click("newCaptureBtn");
  assert.equal(f.elements.captureSetup.hidden, false);
  assert.equal(f.elements.recordBtn.hidden, false);
  assert.equal(f.elements.goalContext.hidden, true);
  assert.equal(f.calls.filter(call => call.type === "extension.startRecording").length, 0);
});
