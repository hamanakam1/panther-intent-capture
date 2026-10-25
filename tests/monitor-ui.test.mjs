import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const model = (await readFile(new URL("../extension/monitor/status-model.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const script = (await readFile(new URL("../extension/monitor/monitor.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
const html = await readFile(new URL("../extension/monitor/monitor.html", import.meta.url), "utf8");
const css = await readFile(new URL("../extension/monitor/monitor.css", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
const idle = power => ({ok: true, enabled: false, status: "idle", power: {state: power}, session: null, result: null});
const capture = () => ({...idle("on"), enabled: true, status: "recording", session: {eventCount: 4, screenshotCount: 1, automation: {enabled: true}}});
const delivery = () => ({...idle("on"), status: "automation", result: {id: "result", eventCount: 4, automationPolicy: {enabled: true}, automationCheckedAt: 1700000000000, automation: {status: "delivering", delivered_count: 1, ticket_count: 2, stage: "delivery"}}});

function fixture(initial, {initialStatus, confirmation = true} = {}) {
  let state = initial, now = 1700000001000, nextTimer = 0;
  const calls = [], elements = {}, responses = new Map(), timers = new Map(), listeners = {}, documentListeners = {};
  if (initialStatus) responses.set("extension.getStatus", initialStatus);
  class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const element = () => ({hidden: false, disabled: false, checked: false, textContent: "", dataset: {}, listeners: {}, children: [], addEventListener(type, fn) {this.listeners[type] = fn;}, replaceChildren(...nodes) {this.children = nodes;}, append(...nodes) {this.children.push(...nodes);}, set innerHTML(value) {throw new Error(`Unsafe HTML write: ${value}`);}});
  const testDocument = {visibilityState: "visible", getElementById(id) {return elements[id] ||= element();}, createElement() {return element();}, addEventListener(type, fn) {documentListeners[type] = fn;}};
  const context = vm.createContext({
    Date: TestDate, console,
    document: testDocument,
    window: {addEventListener(type, fn) {listeners[type] = fn;}},
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, {fn, at: now + delay}); return id; },
    clearTimeout(id) {timers.delete(id);},
    setInterval(fn, delay) {const id = ++nextTimer; timers.set(id, {fn, at: now + delay, interval: delay}); return id;},
    clearInterval(id) {timers.delete(id);},
    confirm: () => confirmation,
    chrome: {runtime: {sendMessage: async message => {
      calls.push(structuredClone(message));
      if (responses.has(message.type)) return responses.get(message.type)(message);
      if (message.type === "extension.turnOn" || message.type === "extension.turnOff") {
        state = {...state, enabled: false, power: {state: message.type === "extension.turnOn" ? "on" : "off"}};
        return {ok: true, power: structuredClone(state.power)};
      }
      return structuredClone(state);
    }}}
  });
  vm.runInContext(`${model}\n${script}`, context);
  return {elements, calls, timers,
    setState(value) {state = value;},
    respond(type, handler) {responses.set(type, handler);},
    clearResponse(type) {responses.delete(type);},
    close() {listeners.pagehide();},
    async visibility(value) {testDocument.visibilityState = value; documentListeners.visibilitychange(); await flush();},
    async toggle(checked) {if (!elements.liveAiToggle.disabled) {elements.liveAiToggle.checked = checked; elements.liveAiToggle.listeners.change(); await flush();}},
    async click(id) {if (!elements[id].disabled && !elements[id].hidden) {const pending = elements[id].listeners.click(); await flush(); return pending;}},
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; now = timer.at;
        if (timer.interval) timer.at += timer.interval; else timers.delete(id);
        timer.fn(); await flush();
      }
      now = target; await flush();
    }
  };
}

test("opening and polling monitor has no capture, delivery, backend fetch or native-start side effect", async () => {
  const f = fixture(idle("off")); await flush(); await f.advance(6000);
  assert.equal(f.elements.powerStatus.textContent, "Panther is off");
  assert.ok(f.calls.length >= 3);
  assert.ok(f.calls.every(call => call.type === "extension.getStatus"));
  assert.equal(f.elements.turnOnBtn.hidden, false);
  assert.equal(f.elements.turnOffBtn.disabled, true);
  assert.doesNotMatch(script, /\bfetch\s*\(|connectNative|startRecording|setEnabled|retryAutomation|retryUpload/);
});

test("explicit On requires no capture consent in this window and does not start recording", async () => {
  const f = fixture(idle("off")); await flush(); await f.click("turnOnBtn");
  assert.equal(f.elements.powerStatus.textContent, "Panther is on");
  assert.equal(f.elements.activity.textContent, "Idle");
  assert.equal(f.elements.turnOffBtn.disabled, false);
  assert.ok(f.calls.some(call => call.type === "extension.turnOn"));
  assert.ok(f.calls.every(call => ["extension.getStatus", "extension.turnOn"].includes(call.type)));
});

test("hanging status has one underlying request, times out unknown and cannot revive cached On", async () => {
  const f = fixture(idle("on")); await flush();
  const pending = deferred(); f.respond("extension.getStatus", () => pending.promise);
  await f.advance(8000);
  assert.equal(f.elements.powerStatus.textContent, "Status unknown");
  assert.equal(f.elements.activity.textContent, "Unknown");
  assert.equal(f.elements.turnOffBtn.disabled, false);
  assert.match(f.elements.error.textContent, /timed out/);
  assert.equal(f.calls.filter(call => call.type === "extension.getStatus").length, 2);
  await f.advance(10000);
  assert.equal(f.calls.filter(call => call.type === "extension.getStatus").length, 2);
  pending.resolve(idle("on")); await flush();
  assert.equal(f.elements.powerStatus.textContent, "Status unknown");
  f.clearResponse("extension.getStatus"); await f.advance(2000);
  assert.equal(f.elements.powerStatus.textContent, "Panther is on");
});

test("Off bypasses a stuck status request and ignores its late On response", async () => {
  const pending = deferred(); const f = fixture(capture(), {initialStatus: () => pending.promise}); await flush();
  assert.equal(f.elements.turnOffBtn.disabled, false);
  await f.click("turnOffBtn");
  assert.equal(f.elements.powerStatus.textContent, "Panther is off");
  pending.resolve(capture()); await flush();
  assert.equal(f.elements.powerStatus.textContent, "Panther is off");
  assert.equal(f.elements.activity.textContent, "Idle");
});

test("Off can interrupt pending On and the late On response cannot overwrite it", async () => {
  const f = fixture(idle("off")); await flush();
  const pending = deferred(); f.respond("extension.turnOn", () => pending.promise);
  const onRequest = f.click("turnOnBtn"); await flush();
  assert.equal(f.elements.powerStatus.textContent, "Turning on…");
  assert.equal(f.elements.turnOffBtn.disabled, false);
  await f.click("turnOffBtn");
  pending.resolve({ok: true, power: {state: "on"}}); await onRequest;
  assert.equal(f.elements.powerStatus.textContent, "Panther is off");
});

test("Off then On during a hung status poll keeps old work retained and idle", async () => {
  const f = fixture(capture()); await flush();
  const pending = deferred(); f.respond("extension.getStatus", () => pending.promise);
  await f.advance(2000);
  await f.click("turnOffBtn");
  await f.click("turnOnBtn");
  assert.equal(f.elements.powerStatus.textContent, "Panther is on");
  assert.equal(f.elements.activity.textContent, "Idle");
  assert.match(f.elements.activityDetail.textContent, /retained, not running/);
  assert.equal(f.elements.stopBtn.hidden, true);
  assert.equal(f.elements.cancelBtn.hidden, true);
  assert.equal(f.elements.eventCount.textContent, "4");
  pending.resolve(capture()); await flush();
  assert.equal(f.elements.activity.textContent, "Idle");
  assert.equal(f.elements.stopBtn.hidden, true);
});

for (const command of ["extension.stopRecording", "extension.cancelAutomation"]) {
  test(`Off remains reachable during pending ${command} and fences its completion`, async () => {
    const f = fixture(capture()); await flush();
    const pending = deferred(); f.respond(command, () => pending.promise);
    const operation = f.click(command === "extension.stopRecording" ? "stopBtn" : "cancelBtn"); await flush();
    assert.equal(f.elements.turnOffBtn.disabled, false);
    await f.click("turnOffBtn");
    assert.equal(f.elements.activity.textContent, "Idle");
    pending.resolve({...delivery(), status: "generating"}); await operation;
    assert.equal(f.elements.powerStatus.textContent, "Panther is off");
    assert.equal(f.elements.activity.textContent, "Idle");
    assert.equal(f.elements.operationStatus.hidden, true);
    assert.equal(f.elements.eventCount.textContent, "4");
    assert.equal(f.elements.historyNote.hidden, false);
  });
}

test("Off remains reachable during reported generation and delivery with historical counts", async () => {
  for (const input of [{...delivery(), status: "generating", result: {...delivery().result, automationPolicy: null}}, delivery()]) {
    const f = fixture(input); await flush();
    assert.equal(f.elements.turnOffBtn.disabled, false);
    await f.click("turnOffBtn");
    assert.equal(f.elements.activity.textContent, "Idle");
    assert.equal(f.elements.eventCount.textContent, "4");
    assert.equal(f.elements.reviewBtn.disabled, true);
    assert.equal(f.elements.cancelBtn.hidden, true);
  }
});

test("cancel requires confirmation and only invokes the scoped cancel command", async () => {
  const denied = fixture(delivery(), {confirmation: false}); await flush(); await denied.click("cancelBtn");
  assert.ok(denied.calls.every(call => call.type === "extension.getStatus"));
  const accepted = fixture(delivery()); await flush(); await accepted.click("cancelBtn");
  assert.ok(accepted.calls.some(call => call.type === "extension.cancelAutomation"));
});

test("old results remain explicitly historical while a new capture advances", async () => {
  const f = fixture({...capture(), result: delivery().result}); await flush();
  assert.equal(f.elements.activity.textContent, "Capturing");
  assert.match(f.elements.draftSummary.textContent, /saved result/);
  assert.match(f.elements.receiptSummary.textContent, /Historical receipts, not current ticket state/);
  assert.match(f.elements.receiptTime.textContent, /does not perform destination readback/);
  f.setState({...capture(), session: {...capture().session, eventCount: 7}, result: delivery().result}); await f.advance(2000);
  assert.equal(f.elements.eventCount.textContent, "7");
});

test("draft and proposal counts use singular and plural labels", async () => {
  const f = fixture({...idle("on"), status: "ready", result: {id: "result", ticketCount: 1}}); await flush();
  assert.equal(f.elements.draftSummary.textContent, "1 draft ticket");
  f.setState(delivery()); await f.advance(2000);
  assert.equal(f.elements.draftSummary.textContent, "2 ticket proposals");
});

test("errors and stage text are text-only, and private captured fields are not rendered", async () => {
  const unsafe = '<img src=x onerror="alert(1)">';
  const input = delivery(); input.result.error = unsafe; input.result.automation.stage = unsafe;
  input.result.goal = "PRIVATE GOAL"; input.result.events = ["PRIVATE EVENT"];
  const f = fixture(input); await flush();
  assert.equal(f.elements.error.textContent, unsafe);
  assert.match(f.elements.receiptSummary.textContent, /<img/);
  assert.doesNotMatch(Object.values(f.elements).map(element => element.textContent).join(" "), /PRIVATE/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
});

test("failed confirmation disables session actions but not Off", async () => {
  const f = fixture(capture()); await flush();
  f.respond("extension.getStatus", () => {throw new Error("worker disconnected");}); await f.advance(2000);
  assert.equal(f.elements.powerStatus.textContent, "Status unknown");
  assert.equal(f.elements.stopBtn.hidden, true);
  assert.equal(f.elements.cancelBtn.hidden, true);
  assert.equal(f.elements.turnOffBtn.disabled, false);
  assert.match(f.elements.error.textContent, /worker disconnected/);
});

test("closing monitor only clears timers and ignores late responses, never stops runtime", async () => {
  const pending = deferred(); const f = fixture(idle("on"), {initialStatus: () => pending.promise}); await flush();
  f.close(); pending.resolve(capture()); await flush(); await f.advance(10000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].type, "extension.getStatus");
  assert.equal(f.elements.activity.textContent, "Unknown");
});

test("markup keeps power controls sticky, named and keyboard reachable at narrow widths", () => {
  for (const id of ["turnOnBtn", "turnOffBtn", "stopBtn", "cancelBtn", "reviewBtn"]) assert.match(html, new RegExp(`<button id="${id}"`));
  assert.match(html, /aria-label="Panther runtime controls"/);
  assert.match(html, /Closing this window does not turn Panther off/);
  assert.match(html, /not an always-on-top overlay/);
  assert.match(css, /\.power-panel\s*\{[^}]*position:\s*sticky/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 340px\)/);
  assert.match(html, /<details id="intentContext"[^>]*>\s*<summary>Capture context<\/summary>/);
  assert.ok(html.indexOf('id="inferredIntent"') < html.indexOf('id="intentContext"'));
  assert.match(html, /<details class="ai-consent-details"><summary>What enabling insights allows<\/summary>/);
  assert.match(html, /No screenshots, cloud fallback or work execution/);
  assert.match(html, /Disabling stops new requests; an already-running local request may finish/);
});

const observed = (count = 4, sessionId = "synthetic-session") => ({...capture(), session: {...capture().session, sessionId, eventCount: count}, live: {sessionId, eventCount: count, observedAt: 1700000000000, source: "rules", summary: "Selected the display settings repeatedly.", inferredIntent: "Possibly trying to change the display.", goal: "Change display settings", page: {title: "Sample settings"}, recentEvents: [{seq: count - 1, ts: 1699999999000, type: "click", label: "Selected settings"}, {seq: count, ts: 1700000000000, type: "click", label: "Selected display"}], patterns: [{title: "Repeated selection", detail: "Repeated clicks might indicate an unclear response.", evidence: [count - 1, count], hypothesis: true}]}});
const aiAnswer = (revision = 4, sessionId = "synthetic-session") => ({ok: true, sessionId, revision, source: "local-ai", model: "synthetic-local-model", analyzedAt: 1700000001000, summary: "The user appears to be exploring display preferences.", intent: "Adjust display preferences", possibleIssue: "The settings response may be unclear.", evidence: [revision - 1, revision], confidence: "low", execution_authorized: false});
const aiCalls = f => f.calls.filter(call => call.type === "extension.analyzeLive");

test("live observed actions and hypotheses render literally with independent event freshness", async () => {
  const input = observed();
  const unsafe = '<img src=x onerror="alert(1)">';
  input.live.recentEvents[1].label = unsafe;
  input.live.goal = unsafe;
  input.live.patterns[0].title = unsafe;
  input.live.page.url = "https://sample.test/settings/display";
  const f = fixture(input); await flush();
  assert.equal(f.elements.understandingMode.textContent, "Live · rules");
  assert.equal(f.elements.recentActions.children.length, 2);
  assert.equal(f.elements.recentActions.children[0].children[1].textContent, unsafe);
  assert.match(f.elements.recentActions.children[0].children[0].textContent, /#4/);
  assert.match(f.elements.statedGoal.textContent, /<img/);
  assert.match(f.elements.frictionList.children[0].textContent, /Hypothesis, not a confirmed defect/);
  assert.match(f.elements.inferredIntent.textContent, /Tentative interpretation · rules/);
  assert.match(f.elements.observedPage.textContent, /Latest observed route: https:\/\/sample.test\/settings\/display/);
  assert.match(f.elements.observedPage.textContent, /Capture-start title: Sample settings/);
  await f.advance(5000);
  assert.match(f.elements.observationFreshness.textContent, /6s ago/);
  assert.match(f.elements.connectionStatus.textContent, /0s ago/);
  assert.equal(aiCalls(f).length, 0);
});

test("local AI defaults off on load even with automatic ticket AI selected", async () => {
  const input = observed(); input.session.automation.ai = true;
  const f = fixture(input); await flush(); await f.advance(30000);
  assert.equal(f.elements.liveAiToggle.checked, false);
  assert.equal(f.elements.liveAiToggle.disabled, false);
  assert.equal(aiCalls(f).length, 0);
  const idleWindow = fixture(idle("on")); await flush();
  assert.equal(idleWindow.elements.liveAiToggle.disabled, true);
  assert.match(idleWindow.elements.understandingSummary.textContent, /not capturing/);
});

test("explicit AI opt-in is scoped and rate-limited to new event revisions", async () => {
  const f = fixture(observed()); await flush();
  f.respond("extension.analyzeLive", () => aiAnswer());
  await f.toggle(true);
  assert.deepEqual(aiCalls(f)[0], {type: "extension.analyzeLive", sessionId: "synthetic-session", consent: true});
  assert.equal(f.elements.liveAiResult.hidden, false);
  assert.match(f.elements.liveAiProvenance.textContent, /Local AI hypothesis/);
  assert.match(f.elements.liveAiProvenance.textContent, /model-rated low confidence/);
  assert.match(f.elements.liveAiEvidence.textContent, /through event #4/);
  await f.advance(30000);
  assert.equal(aiCalls(f).length, 1);
  f.setState(observed(6)); f.respond("extension.analyzeLive", () => aiAnswer(6));
  await f.advance(1000);
  assert.equal(aiCalls(f).length, 2);
  f.setState(observed(8)); f.respond("extension.analyzeLive", () => aiAnswer(8));
  await f.advance(1000);
  assert.equal(aiCalls(f).length, 2);
  assert.match(f.elements.liveAiEvidence.textContent, /2 newer events not analyzed/);
  await f.advance(14000);
  assert.equal(aiCalls(f).length, 3);
});

test("AI errors do not retry unchanged evidence or block observed activity and Off", async () => {
  const f = fixture(observed()); await flush();
  f.respond("extension.analyzeLive", () => ({ok: false, error: "Local model is unavailable"}));
  await f.toggle(true); await f.advance(45000);
  assert.equal(aiCalls(f).length, 1);
  assert.match(f.elements.liveAiStatus.textContent, /Local AI unavailable/);
  assert.match(f.elements.liveAiStatus.textContent, /no cloud fallback/);
  assert.equal(f.elements.turnOffBtn.disabled, false);
  assert.equal(f.elements.understandingMode.textContent, "Live · rules");
  await f.toggle(false); await f.toggle(true); await f.advance(1000);
  assert.equal(aiCalls(f).length, 1);
});

test("pending AI is single-flight, timeout-safe and never disables Off", async () => {
  const f = fixture(observed()); await flush(); const pending = deferred();
  f.respond("extension.analyzeLive", () => pending.promise);
  await f.toggle(true);
  assert.equal(f.elements.turnOffBtn.disabled, false);
  f.setState(observed(7)); await f.advance(22000);
  assert.equal(aiCalls(f).length, 1);
  assert.match(f.elements.liveAiStatus.textContent, /Local AI unavailable/);
  assert.equal(f.elements.eventCount.textContent, "7");
  pending.resolve(aiAnswer()); await flush();
  assert.equal(f.elements.liveAiResult.hidden, true);
});

for (const boundary of ["off", "disable", "hidden", "new-session", "revoked", "stop", "close", "stale"]) {
  test(`late local AI is discarded across ${boundary} boundary`, async () => {
    const f = fixture(observed()); await flush(); const pending = deferred();
    f.respond("extension.analyzeLive", () => pending.promise);
    await f.toggle(true);
    if (boundary === "off") await f.click("turnOffBtn");
    if (boundary === "disable") await f.toggle(false);
    if (boundary === "hidden") await f.visibility("hidden");
    if (boundary === "new-session") {f.setState(observed(4, "new-session")); await f.advance(1000);}
    if (boundary === "revoked") {f.setState({...observed(), enabled: false}); await f.advance(1000);}
    if (boundary === "stop") {f.respond("extension.stopRecording", () => ({ok: true, status: "ready", session: null, result: {id: "saved"}, live: observed().live})); await f.click("stopBtn");}
    if (boundary === "close") f.close();
    if (boundary === "stale") {f.respond("extension.getStatus", () => deferred().promise); await f.advance(8000);}
    pending.resolve(aiAnswer()); await flush();
    assert.equal(f.elements.liveAiResult.hidden, true);
    if (boundary !== "close") assert.equal(f.elements.liveAiToggle.checked, false);
    assert.ok(f.calls.some(call => call.type === "extension.cancelLiveAnalysis" && call.sessionId === "synthetic-session"));
    if (boundary === "off") assert.equal(f.elements.powerStatus.textContent, "Panther is off");
  });
}

test("Off retains prior rule and AI interpretations as historical without automatic resumption", async () => {
  const f = fixture(observed()); await flush(); f.respond("extension.analyzeLive", () => aiAnswer());
  await f.toggle(true); await f.click("turnOffBtn");
  assert.equal(f.elements.understandingMode.textContent, "Historical · rules");
  assert.match(f.elements.liveAiProvenance.textContent, /Historical local AI hypothesis/);
  assert.match(f.elements.observationFreshness.textContent, /retained evidence, not current activity/);
  const pending = deferred(); f.respond("extension.getStatus", () => pending.promise);
  await f.click("turnOnBtn"); await f.advance(1000);
  assert.equal(f.elements.liveAiToggle.checked, false);
  assert.equal(aiCalls(f).length, 1);
});

test("model answers are bounded plain text and cannot claim execution authority", async () => {
  const f = fixture(observed()); await flush();
  const unsafe = '<svg onload="alert(1)">';
  f.respond("extension.analyzeLive", () => ({...aiAnswer(), summary: unsafe, intent: "x".repeat(1000), evidence: [0, -1, 3, 4, 100, "3"]}));
  await f.toggle(true);
  assert.equal(f.elements.liveAiSummary.textContent, unsafe);
  assert.equal(f.elements.liveAiIntent.textContent.length, "Tentative intent: ".length + 600);
  assert.match(f.elements.liveAiEvidence.textContent, /Evidence #3, #4/);
  const denied = fixture(observed()); await flush();
  denied.respond("extension.analyzeLive", () => ({...aiAnswer(), execution_authorized: true}));
  await denied.toggle(true);
  assert.equal(denied.elements.liveAiResult.hidden, true);
  assert.match(denied.elements.liveAiStatus.textContent, /No valid local interpretation/);
});

test("pending Stop disables AI opt-in while Off stays independent", async () => {
  const f = fixture(observed()); await flush(); const pending = deferred();
  f.respond("extension.stopRecording", () => pending.promise);
  const stopping = f.click("stopBtn"); await flush();
  assert.equal(f.elements.liveAiToggle.disabled, true);
  assert.equal(f.elements.turnOffBtn.disabled, false);
  await f.toggle(true);
  assert.equal(aiCalls(f).length, 0);
  pending.resolve({ok: true, status: "ready", session: null, result: {id: "saved"}});
  f.respond("extension.getStatus", () => deferred().promise);
  await stopping;
  assert.equal(f.elements.understandingMode.textContent, "Historical · rules");
  assert.equal(f.elements.recentActions.children.length, 2);
});


test("monitor has exactly one document, module, and unique controls", () => {
  for (const tag of ["html", "head", "body"]) {
    assert.equal((html.match(new RegExp(`<${tag}(?:\\s|>)`, "gi")) || []).length, 1, `one ${tag} document`);
    assert.equal((html.match(new RegExp(`</${tag}>`, "gi")) || []).length, 1, `one closing ${tag}`);
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, "IDs must be unique in the real markup");
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.doesNotMatch(html, /id="(?:consent|goal|startBtn|screenshots|automation|automationAI)"/, "no unwired capture controls in a status-only surface");
  assert.match(html, /http:\/\/127\.0\.0\.1:8765/);
});

test("next step follows confirmed state and stale state never suggests active recording", async () => {
  const f = fixture(idle("off")); await flush();
  assert.match(f.elements.nextTitle.textContent, /clear intention/);
  assert.equal(f.elements.stepCapture.dataset.current, "true");
  f.setState(observed()); await f.advance(1000);
  assert.match(f.elements.nextTitle.textContent, /workflow/);
  f.respond("extension.getStatus", () => {throw new Error("lost connection");}); await f.advance(1000);
  assert.match(f.elements.nextTitle.textContent, /connection/);
  assert.equal(f.elements.stepCapture.dataset.current, "false");
  f.clearResponse("extension.getStatus"); f.setState({...idle("on"), status: "ready", result: {id: "saved", ticketCount: 1}}); await f.advance(1000);
  assert.equal(f.elements.stepHandoff.dataset.current, "true");
  assert.match(f.elements.nextDetail.textContent, /Companion/);
});
