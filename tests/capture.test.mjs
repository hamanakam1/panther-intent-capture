import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCaptureController, SESSION_KEY, RESULT_KEY, SETTINGS_KEY, BROWSER_KEY, MAX_EVENTS, AUTOMATION_ALARM } from "../extension/shared/capture.js";
import { sanitizeCaptureEvent, sanitizeText, sanitizeUrl } from "../extension/shared/redaction.js";

const control = { id: "test-extension", url: "chrome-extension://test-extension/popup/popup.html" };
const page = { id: "test-extension", tab: { id: 7 }, frameId: 0, url: "https://app.test/dashboard" };
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const monitor = { ...control, url: `chrome-extension://${control.id}/monitor/monitor.html` };
const flushLive = () => new Promise(resolve => setImmediate(resolve));
const liveReply = payload => ({ ok: true, sessionId: payload.sessionId, revision: payload.revision, source: "local-ai", model: "synthetic-local-model",
  analyzedAt: 1700000010000, summary: "The captured control was clicked.", intent: "Possible attempt to save changes.", possibleIssue: "", evidence: [payload.events.at(-1).seq], confidence: "low", execution_authorized: false });

function fixture(options = {}) {
  const data = { [SETTINGS_KEY]: { enabled: true }, ...clone(options.data || {}) };
  const sessionData = {};
  const alarms = new Map();
  const calls = { inject: [], messages: [], captures: [], fetch: [], badges: [], tabs: [] };
  const activeTab = { id: 7, windowId: 42, url: "https://app.test/dashboard?token=private#work-board", title: "Dashboard" };
  let timestamp = 1700000000000;
  let powerOn = options.powerOn !== false;
  const api = {
    alarms: { get: async (name) => alarms.get(name), create: async (name, value) => alarms.set(name, clone(value)), clear: async (name) => alarms.delete(name) },
    runtime: { id: control.id, getURL: (path) => `chrome-extension://${control.id}/${path}`, getManifest: () => ({ name: "Panther" }) },
    storage: { session: {
      get: async (key) => ({ [key]: clone(sessionData[key]) }),
      set: async (patch) => { Object.assign(sessionData, clone(patch)); }
    }, local: {
      get: async (key) => ({ [key]: clone(data[key]) }),
      set: async (patch) => { for (const [key, value] of Object.entries(patch)) data[key] = clone(value); },
      remove: async (key) => { delete data[key]; }
    } },
    action: { setBadgeText: async (value) => calls.badges.push(value), setBadgeBackgroundColor: async () => {} },
    tabs: {
      query: async () => [clone(activeTab)],
      sendMessage: async (...args) => { calls.messages.push(args); return { ok: true }; },
      captureVisibleTab: async (...args) => { calls.captures.push(args); return "data:image/jpeg;base64,/9j/2Q=="; },
      create: async (tab) => { calls.tabs.push(tab); }
    },
    scripting: { executeScript: async (value) => { calls.inject.push(value); } }
  };
  let fetchBehavior = options.fetch || (async (url) => ({ ok: true, json: async () => url.endsWith("/record") ? { id: "record-1" } : { tickets: [{ title: "Review observed intent" }] } }));
  const fetcher = async (url, init) => { calls.fetch.push({ url, init }); return fetchBehavior(url, init); };
  const makeController = () => createCaptureController(api, fetcher, () => timestamp++, { isPowered: () => powerOn });
  let controller = makeController();
  return {
    api, data, sessionData, calls, activeTab, alarms,
    get controller() { return controller; },
    restartWorker() { controller = makeController(); return controller; },
    setFetch(fn) { fetchBehavior = fn; },
    advance(ms) { timestamp += ms; },
    async turnOff() { powerOn = false; return controller.freeze("Panther is Off; accepted requests are unconfirmed."); },
    turnOn() { powerOn = true; controller.unlock(); },
    send(type, values = {}, sender = control) { return controller.message({ type, ...values }, sender); },
    start(values = {}) { return this.send("extension.startRecording", { tabId: 7, consent: true, ...values }); },
    event(values = {}, sender = page) { return this.send("page.interaction", { sessionId: data[SESSION_KEY]?.sessionId, payload: { type: "click", url: activeTab.url, target: { tag: "button", label: "Save" }, ...values } }, sender); },
    contentInjections() { return calls.inject.filter((call) => Array.isArray(call.files)); },
    mainWorldInjections() { return calls.inject.filter((call) => call.world === "MAIN"); }
  };
}

test("all manifests are valid and Chromium permissions are scoped to an invoked tab", async () => {
  for (const variant of ["", ".chrome", ".firefox", ".safari"]) {
    const manifest = JSON.parse(await readFile(new URL(`../extension/manifest${variant}.json`, import.meta.url)));
    assert.deepEqual(manifest.permissions, ["storage", "activeTab", "scripting", "alarms", ...(!variant || variant === ".chrome" ? ["nativeMessaging"] : [])]);
    assert.equal(manifest.version, "1.7.0");
    assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1:7890/*"]);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.offscreen, undefined);
    if (!variant || variant === ".chrome") assert.equal(manifest.minimum_chrome_version, "116");
  }
});

test("live evidence is bounded and restricted to trusted monitor status, including after Save", async () => {
  const f = fixture(); await f.start({goal: "Make this control clearer"});
  for (let n = 0; n < 20; n++) await f.event({ target: {tag: "button", label: "Save", value: "NEVER KEEP", text: "PRIVATE RAW TEXT"} });
  const live = (await f.send("extension.getStatus", {}, monitor)).live;
  assert.equal(live.eventCount, 20);
  assert.equal(live.recentEvents.length, 12);
  assert.equal(live.recentEvents[0].seq, 9);
  assert.equal(live.source, "rules");
  assert.doesNotMatch(JSON.stringify(live), /NEVER KEEP|PRIVATE RAW TEXT/);
  assert.equal((await f.send("extension.getStatus")).live, undefined);
  assert.equal((await f.send("page.getStatus", {}, page)).live, undefined);
  assert.equal(f.calls.fetch.length, 0);
  await f.send("extension.stopRecording", {}, monitor);
  const saved = await f.send("extension.getStatus", {}, monitor);
  assert.equal(saved.live.eventCount, 20);
  assert.equal(saved.result.live, undefined);
  assert.equal((await f.send("page.getStatus", {}, page)).result.live, undefined);
});

test("live inference needs monitor authority, matching active session and explicit opt-in", async () => {
  const f = fixture(); await f.start(); await f.event();
  const args = {sessionId: f.data[SESSION_KEY].sessionId, consent: true};
  for (const sender of [control, page, {...monitor, id:"other"}, {...monitor, url:`${monitor.url}/bad`}]) {
    assert.equal((await f.send("extension.analyzeLive", args, sender)).ok, false);
  }
  await assert.rejects(f.send("extension.analyzeLive", {...args, consent:false}, monitor), /Enable live/);
  await assert.rejects(f.send("extension.analyzeLive", {...args, sessionId:"stale"}, monitor), /current consented/);
  await f.turnOff(); f.turnOn();
  await assert.rejects(f.send("extension.analyzeLive", args, monitor), /current consented/);
  assert.equal(f.calls.fetch.length, 0);
});

test("live inference uses only stored sanitized observations and makes no ticket or storage mutation", async () => {
  const f = fixture({fetch: async (url, init) => ({ok:true,json:async()=>liveReply(JSON.parse(init.body))})});
  await f.start({goal:"Improve Save token=private"}); await f.event();
  const before = clone(f.data);
  const result = await f.send("extension.analyzeLive", {sessionId:f.data[SESSION_KEY].sessionId,consent:true,events:[{label:"INJECTED"}],automation:{enabled:true}}, monitor);
  assert.equal(result.source,"local-ai"); assert.equal(result.execution_authorized,false);
  assert.deepEqual(f.data,before);
  assert.equal(f.calls.fetch.length,1);
  assert.ok(f.calls.fetch[0].url.endsWith("/live-insight"));
  const payload = JSON.parse(f.calls.fetch[0].init.body);
  assert.deepEqual(Object.keys(payload).sort(),["consent","events","goal","page","revision","sessionId"]);
  assert.doesNotMatch(JSON.stringify(payload),/INJECTED|token=private|screenshots|automation/);
  assert.equal(payload.events.length,1);
});

test("live inference is throttled and never retries an unchanged revision", async () => {
  const f = fixture({fetch:async(url,init)=>({ok:true,json:async()=>liveReply(JSON.parse(init.body))})});
  await f.start(); await f.event(); const args={sessionId:f.data[SESSION_KEY].sessionId,consent:true};
  await f.send("extension.analyzeLive",args,monitor);
  await f.event(); await assert.rejects(f.send("extension.analyzeLive",args,monitor),/15 seconds/);
  f.advance(15000); await f.send("extension.analyzeLive",args,monitor);
  f.advance(15000); await assert.rejects(f.send("extension.analyzeLive",args,monitor),/new captured actions/);
  assert.equal(f.calls.fetch.length,2);
});

test("slow live inference does not block events or status and Off aborts and fences its result", async () => {
  let resolve; const held=new Promise(r=>{resolve=r;});
  const f=fixture({fetch:async()=>held}); await f.start(); await f.event();
  const pending=f.send("extension.analyzeLive",{sessionId:f.data[SESSION_KEY].sessionId,consent:true},monitor);
  const rejected=assert.rejects(pending,/interrupted|Off|superseded/); await flushLive();
  await f.event(); assert.equal((await f.send("extension.getStatus",{},monitor)).live.eventCount,2);
  await assert.rejects(f.send("extension.analyzeLive",{sessionId:f.data[SESSION_KEY].sessionId,consent:true},monitor),/already running/);
  await f.turnOff(); await rejected;
  assert.equal(f.calls.fetch[0].init.signal.aborted,true);
  resolve({ok:true,json:async()=>liveReply(JSON.parse(f.calls.fetch[0].init.body))});
  await flushLive(); assert.equal(f.data[SESSION_KEY].powerPaused,true);
  assert.equal(f.data[RESULT_KEY],undefined);
});

test("monitor can cancel only its matching live inference without changing capture consent", async () => {
  const f=fixture({fetch:async()=>new Promise(()=>{})}); await f.start(); await f.event();
  const args={sessionId:f.data[SESSION_KEY].sessionId,consent:true};
  const pending=f.send("extension.analyzeLive",args,monitor); const rejected=assert.rejects(pending,/interrupted/); await flushLive();
  assert.equal((await f.send("extension.cancelLiveAnalysis",{sessionId:"other"},monitor)).cancelled,false);
  assert.equal((await f.send("extension.cancelLiveAnalysis",args,monitor)).cancelled,true);
  await rejected; assert.equal(f.data[SETTINGS_KEY].enabled,true); assert.equal(f.data[SESSION_KEY].status,"recording");
});

test("Stop and capture consent withdrawal abort optional inference without waiting for it", async () => {
  for (const type of ["extension.stopRecording","extension.setEnabled"]) {
    const f=fixture({fetch:async(url)=>url.endsWith("live-insight")?new Promise(()=>{}):({ok:true,json:async()=>url.endsWith("/record")?{id:"record-1"}:{tickets:[]}})});
    await f.start(); await f.event();
    const pending=f.send("extension.analyzeLive",{sessionId:f.data[SESSION_KEY].sessionId,consent:true},monitor);
    const rejected=assert.rejects(pending,/interrupted/); await flushLive();
    await f.send(type,{enabled:false}); await rejected;
    assert.equal(f.calls.fetch[0].init.signal.aborted,true);
  }
});

test("invalid live model evidence and malformed responses are rejected without state mutation", async () => {
  for (const change of [{evidence:[999]}, {execution_authorized:true}, {sessionId:"other"}, {revision:999}, {confidence:"high"}, {summary:42}, {evidence:[]}]) {
    const f=fixture({fetch:async(url,init)=>({ok:true,json:async()=>({...liveReply(JSON.parse(init.body)),...change})})});
    await f.start(); await f.event(); const before=clone(f.data);
    await assert.rejects(f.send("extension.analyzeLive",{sessionId:f.data[SESSION_KEY].sessionId,consent:true},monitor),/ungrounded/);
    assert.deepEqual(f.data,before);
  }
});

test("worker requires stored consent, fresh start consent, and the active ordinary webpage", async () => {
  const f = fixture({ data: { [SETTINGS_KEY]: { enabled: false } } });
  await assert.rejects(f.start(), /consent/);
  assert.equal(f.calls.inject.length, 0);
  await f.send("extension.setEnabled", { enabled: true });
  await assert.rejects(f.start({ consent: false }), /consent/);
  await assert.rejects(f.start({ tabId: 9 }), /active tab/);
  f.activeTab.url = "chrome://settings";
  await assert.rejects(f.start(), /ordinary http/);
  f.activeTab.url = "https://app.test";
  await assert.rejects(f.start({ video: true }), /not supported/);
  f.api.runtime.getManifest = () => ({ name: "Panther (Firefox preview)" });
  await assert.rejects(f.start(), /unsupported preview/);
});

test("popup tabId works without sender.tab and only the top frame is injected", async () => {
  const f = fixture();
  const result = await f.start({ goal: "Make filtering clearer" });
  assert.equal(result.status, "recording");
  // The content script and the main-world failure relay both target only the
  // top frame of the chosen tab, and the relay carries the session nonce.
  assert.equal(f.contentInjections().length, 1);
  assert.deepEqual(f.contentInjections()[0], { target: { tabId: 7, frameIds: [0] }, files: ["content/content.js"] });
  assert.equal(f.mainWorldInjections().length, 1);
  assert.deepEqual(f.mainWorldInjections()[0].target, { tabId: 7, frameIds: [0] });
  assert.deepEqual(f.mainWorldInjections()[0].args, [f.data[SESSION_KEY].diagnosticNonce]);
  assert.equal(f.data[SESSION_KEY].url, "https://app.test/dashboard#work-board");
  assert.equal(f.data[SESSION_KEY].goal, "Make filtering clearer");
  assert.equal(f.data[SESSION_KEY].screenshotConsent, false);
  assert.ok(f.calls.badges.some((value) => value.text === "REC"));
});

test("page failures join the capture timeline only for the active consented session", async () => {
  const f = fixture();
  await f.start();
  const id = f.data[SESSION_KEY].sessionId;
  const accepted = await f.send("page.diagnostic", { sessionId: id, payload: {
    type: "diagnostic",
    diagnostic: { kind: "http_error", message: "A request returned HTTP 500", source: "https://app.test/api/tickets?token=private", status: 500, private: "never" }
  } }, page);
  assert.equal(accepted.ok, true);
  const event = f.data[SESSION_KEY].events.at(-1);
  assert.equal(event.type, "diagnostic");
  assert.equal(event.diagnostic.kind, "http_error");
  assert.equal(event.diagnostic.status, 500);
  assert.equal(event.diagnostic.source, "https://app.test/api/tickets");
  assert.doesNotMatch(JSON.stringify(event), /private|never/);
  // Another session, another tab, another frame and another origin are refused.
  for (const sender of [{ ...page, tab: { id: 8 } }, { ...page, frameId: 1 }, { ...page, url: "https://other.test" }, { ...page, id: "other-extension" }]) {
    assert.equal((await f.send("page.diagnostic", { sessionId: id, payload: { type: "diagnostic", diagnostic: { kind: "http_error", status: 500 } } }, sender)).ignored, true);
  }
  assert.equal((await f.send("page.diagnostic", { sessionId: "stale-session", payload: { type: "diagnostic", diagnostic: { kind: "http_error", status: 500 } } }, page)).ignored, true);
  assert.equal(f.data[SESSION_KEY].events.length, 1);
});

test("a stopped or unconsented capture refuses page failures", async () => {
  const f = fixture();
  await f.start();
  const id = f.data[SESSION_KEY].sessionId;
  await f.send("extension.stopRecording", {}, monitor);
  const refused = await f.send("page.diagnostic", { sessionId: id, payload: { type: "diagnostic", diagnostic: { kind: "http_error", status: 500 } } }, page);
  assert.equal(refused.ignored, true);
});

test("page senders cannot invoke extension controls or impersonate another tab/frame/origin", async () => {
  const f = fixture();
  const rejected = await f.send("extension.startRecording", { tabId: 7, consent: true }, page);
  assert.equal(rejected.ok, false);
  await f.start();
  for (const sender of [{ ...page, tab: { id: 8 } }, { ...page, frameId: 1 }, { ...page, url: "https://other.test" }, { ...page, id: "other-extension" }]) {
    assert.equal((await f.event({}, sender)).ignored, true);
  }
  assert.equal((await f.send("page.interaction", { sessionId: "stale-session", payload: { type: "click" } }, page)).ignored, true);
  assert.equal(f.data[SESSION_KEY].events.length, 0);
});

test("known extension popup and options pages can control capture in tabs or windows without URL-prefix spoofing", async () => {
  const f = fixture();
  for (const path of ["popup/popup.html", "options/options.html?recording=rec"]) {
    const sender = { ...control, tab: { id: 99 }, url: `chrome-extension://${control.id}/${path}` };
    assert.equal((await f.send("extension.getStatus", {}, sender)).ok, true);
  }
  for (const url of [
    `chrome-extension://${control.id}.attacker/popup/popup.html`,
    `chrome-extension://${control.id}/popup/popup.html/extra`,
    `chrome-extension://${control.id}/background/background.js`,
    `chrome-extension://attacker@${control.id}/popup/popup.html`,
    `https://${control.id}/popup/popup.html`
  ]) assert.equal((await f.send("extension.getStatus", {}, { ...control, url })).ok, false);
});

test("monitor can observe, stop active capture and review but cannot select consent or start or resume work", async () => {
  const f = fixture();
  const sender = { ...control, url: `chrome-extension://${control.id}/monitor/monitor.html` };
  assert.equal((await f.send("extension.getStatus", {}, sender)).ok, true);
  for (const type of ["extension.setEnabled", "extension.startRecording", "extension.getAutomationTarget",
    "extension.refreshAutomation", "extension.retryAutomation", "extension.retryGeneration", "extension.retryUpload", "extension.discardCapture"]) {
    const result = await f.send(type, { enabled: true, tabId: 7, consent: true }, sender);
    assert.equal(result.ok, false, type);
    assert.match(result.error, /toolbar popup/);
  }
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.inject.length, 0);
  assert.equal((await f.send("extension.openReview", {}, sender)).ok, true);
  assert.equal(f.calls.tabs.length, 1);
  await f.start();
  await f.event();
  assert.equal((await f.send("extension.stopRecording", {}, sender)).status, "ready");
  assert.equal(f.calls.fetch.length, 2);
});

test("monitor stop cannot replay a retained capture after Off and On", async () => {
  const f = fixture();
  const sender = { ...control, url: `chrome-extension://${control.id}/monitor/monitor.html` };
  await f.start(); await f.event(); await f.turnOff(); f.turnOn();
  const state = await f.send("extension.getStatus", {}, sender);
  assert.equal(state.status, "pending");
  assert.equal(state.session.powerPaused, true);
  assert.equal((await f.send("extension.stopRecording", {}, sender)).ok, false);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.data[SESSION_KEY].events.length, 1);
});

test("monitor can withdraw automatic delivery from an active capture without creating or delivering tickets", async () => {
  const f = fixture({ fetch: async () => ({ ok: true, json: async () => ({ url: "http://127.0.0.1:8080" }) }) });
  await f.start({ automation: { enabled: true, consent: true, target_kind: "ticket-service", target_url: "http://127.0.0.1:8080", max_tickets: 5, use_ai: false } });
  const sender = { ...control, url: `chrome-extension://${control.id}/monitor/monitor.html` };
  const state = await f.send("extension.cancelAutomation", {}, sender);
  assert.equal(state.session.automationWithdrawn, true);
  assert.equal(state.status, "recording");
  assert.equal(f.calls.fetch.filter((call) => call.init?.method === "POST").length, 0);
});

test("allowlisted event metadata drops input values, keys, arbitrary bodies and secret URLs", async () => {
  const f = fixture();
  await f.start();
  await f.event({ value: "typed-private-value", key: "p", password: "secret", body: "private body", target: { tag: "input", value: "private", label: "typed private", type: "password", id: "login" }, url: "https://user:pass@app.test/?api_key=secret#access_token=abc" });
  const serialized = JSON.stringify(f.data[SESSION_KEY].events);
  for (const secret of ["typed-private-value", "typed private", "private body", "api_key", "access_token", "user:pass"]) assert.ok(!serialized.includes(secret));
  assert.deepEqual(f.data[SESSION_KEY].events[0].target, { tag: "input", id: "login", type: "password" });
  assert.equal(f.calls.captures.length, 0);
});

test("captures dashboard semantic references and preserves safe routes", () => {
  const out = sanitizeCaptureEvent({ type: "click", url: "http://127.0.0.1:8080/#master", target: { tag: "button", dataTab: "master", dataTicket: "M-12345", label: "Open" } }, 123);
  assert.equal(out.target.dataTab, "master");
  assert.equal(out.target.dataTicket, "M-12345");
  assert.equal(out.url, "http://127.0.0.1:8080/#master");
  assert.equal(out.ts, 123);
  assert.equal(sanitizeCaptureEvent({ type: "keydown", key: "x" }), null);
  assert.equal(sanitizeUrl("https://app.test/reset/token/secret-value?query=secret#token=secret"), "https://app.test/reset/token/REDACTED");
  assert.equal(sanitizeUrl("javascript:alert(1)"), "");
  assert.equal(sanitizeUrl("https://app.test/%74oken/private#token/private"), "https://app.test/%74oken/REDACTED");
  assert.equal(sanitizeText("password=hunter2 hi person@example.com"), "[REDACTED] hi [EMAIL]");
});

test("event writes are serialized and survive worker recreation", async () => {
  const f = fixture();
  await f.start();
  await Promise.all(Array.from({ length: 50 }, (_, i) => f.event({ target: { tag: "button", label: `Action ${i}` } })));
  assert.equal(f.data[SESSION_KEY].events.length, 50);
  f.restartWorker();
  assert.equal((await f.send("extension.getStatus")).session.eventCount, 50);
  await f.event();
  assert.equal(f.data[SESSION_KEY].events.length, 51);
});

test("inject failures leave no phantom recording", async () => {
  const f = fixture();
  f.api.scripting.executeScript = async () => { throw new Error("Cannot access page"); };
  await assert.rejects(f.start(), /Cannot access page/);
  assert.equal(f.data[SESSION_KEY], undefined);
});

test("screenshots require explicit consent, chosen visible tab and window id; count is bounded", async () => {
  const f = fixture();
  await f.start({ screenshots: true });
  for (let i = 0; i < 7; i++) { f.advance(4000); await f.event(); }
  assert.equal(f.calls.captures.length, 5);
  assert.equal(f.calls.captures[0][0], 42);
  assert.equal(f.data[SESSION_KEY].screenshots.length, 5);
  await f.send("extension.stopRecording");
  const upload = JSON.parse(f.calls.fetch[0].init.body);
  assert.equal(upload.screenshotsConsent, true);
  assert.equal(upload.screenshots.length, 5);
});

test("screenshots never capture a different active tab and discard a raced tab switch", async () => {
  const f = fixture();
  await f.start({ screenshots: true });
  f.activeTab.id = 8;
  await f.event();
  assert.equal(f.calls.captures.length, 0);
  f.activeTab.id = 7;
  f.api.tabs.captureVisibleTab = async () => { f.activeTab.id = 8; return "data:image/jpeg;base64,/9j/2Q=="; };
  await f.event();
  assert.equal(f.data[SESSION_KEY].screenshots.length, 0);
});

test("screenshot permission failures warn durably without stopping event capture or losing saved results", async () => {
  const f = fixture();
  await f.start({ screenshots: true });
  f.api.tabs.captureVisibleTab = async () => { throw new Error("activeTab permission required"); };
  const event = await f.event();
  assert.equal(event.ok, true);
  assert.match(event.warning, /toolbar icon/);
  f.restartWorker();
  const recording = await f.send("extension.getStatus");
  assert.equal(recording.status, "recording");
  assert.equal(recording.session.eventCount, 1);
  assert.match(recording.session.warning, /Screenshots unavailable/);
  const stopped = await f.send("extension.stopRecording");
  assert.equal(stopped.status, "ready");
  assert.equal(stopped.result.screenshotCount, 0);
  assert.match(stopped.result.warning, /Screenshots unavailable/);
});

test("failed upload remains durable and retry reuses session identity before generating drafts", async () => {
  const f = fixture({ fetch: async () => ({ ok: false, status: 503 }) });
  await f.start();
  await f.event();
  const first = await f.send("extension.stopRecording");
  assert.equal(first.ok, false);
  assert.equal(first.status, "pending");
  assert.equal(f.data[SESSION_KEY].events.length, 1);
  assert.match(first.error, /HTTP 503/);
  const originalId = JSON.parse(f.calls.fetch[0].init.body).sessionId;
  f.restartWorker();
  f.setFetch(async (url) => ({ ok: true, json: async () => url.endsWith("/record") ? { id: "saved-record" } : { tickets: [{ title: "Draft" }] } }));
  const retry = await f.send("extension.retryUpload");
  assert.equal(retry.status, "ready");
  assert.equal(retry.result.ticketCount, 1);
  assert.equal(f.data[SESSION_KEY], undefined);
  assert.equal(JSON.parse(f.calls.fetch[1].init.body).sessionId, originalId);
  assert.equal(f.calls.fetch[1].init.headers["X-Panther-Client"], "extension-v1");
  assert.deepEqual(JSON.parse(f.calls.fetch[2].init.body), { use_ai: false });
});

test("no recording receipt means capture remains retryable even on HTTP success", async () => {
  const f = fixture({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await f.start();
  const result = await f.send("extension.stopRecording");
  assert.equal(result.status, "pending");
  assert.match(result.error, /receipt/);
});

test("generation failure retains saved recording and retries without uploading again", async () => {
  const f = fixture({ fetch: async (url) => url.endsWith("/record") ? { ok: true, json: async () => ({ id: "record-1" }) } : { ok: false, status: 500 } });
  await f.start();
  const result = await f.send("extension.stopRecording");
  assert.equal(result.status, "error");
  assert.equal(result.result.id, "record-1");
  assert.equal(f.data[SESSION_KEY], undefined);
  f.setFetch(async () => ({ ok: true, json: async () => ({ tickets: [] }) }));
  assert.equal((await f.send("extension.retryGeneration")).status, "ready");
  assert.equal(f.calls.fetch.filter((call) => call.url.endsWith("/record")).length, 1);
  await f.send("extension.openReview");
  assert.match(f.calls.tabs[0].url, /options\/options.html\?recording=record-1$/);
});

test("status stays responsive during save and automatic draft generation", async () => {
  let resolveUpload;
  const f = fixture({ fetch: async (url) => url.endsWith("/record") ? new Promise((resolve) => { resolveUpload = resolve; }) : { ok: true, json: async () => ({ tickets: [] }) } });
  await f.start();
  const stopping = f.send("extension.stopRecording");
  while (!resolveUpload) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.send("extension.getStatus")).status, "saving");
  resolveUpload({ ok: true, json: async () => ({ id: "record-1" }) });
  await stopping;
  assert.equal((await f.send("extension.getStatus")).status, "ready");
});

test("same-origin reload reinjects but cross-origin navigation stops and saves", async () => {
  const f = fixture();
  await f.start();
  await f.controller.tabUpdated(7, { status: "complete" }, { url: "https://app.test/other" });
  assert.equal(f.contentInjections().length, 2);
  await f.controller.tabUpdated(7, { url: "https://other.test" }, { url: "https://other.test" });
  assert.equal(f.data[SESSION_KEY], undefined);
  assert.equal(JSON.parse(f.calls.fetch[0].init.body).stopReason, "left_origin");
});

test("closing chosen tab preserves capture; unrelated tab closure is ignored", async () => {
  const f = fixture();
  await f.start();
  await f.controller.tabRemoved(8);
  assert.equal(f.calls.fetch.length, 0);
  await f.controller.tabRemoved(7);
  assert.equal(JSON.parse(f.calls.fetch[0].init.body).stopReason, "tab_closed");
});

test("revoking consent stops capture and rejects subsequent events", async () => {
  const f = fixture();
  await f.start();
  await f.event();
  await f.send("extension.setEnabled", { enabled: false });
  assert.equal(f.data[SETTINGS_KEY].enabled, false);
  assert.equal(JSON.parse(f.calls.fetch[0].init.body).stopReason, "consent_revoked");
  assert.equal((await f.event()).ignored, true);
});

test("browser restart turns unfinished capture into pending without silent upload", async () => {
  const f = fixture();
  await f.start();
  await f.event();
  await f.controller.browserStarted();
  assert.equal(f.data[SESSION_KEY].status, "pending");
  assert.equal(f.data[SESSION_KEY].stopReason, "browser_restarted");
  assert.equal(f.calls.fetch.length, 0);
});

test("browser-session marker prevents restored tab events from resuming capture before onStartup", async () => {
  const f = fixture();
  await f.start();
  await f.event();
  assert.equal(f.sessionData[BROWSER_KEY], true);
  delete f.sessionData[BROWSER_KEY];
  f.restartWorker();
  await f.controller.tabUpdated(7, { status: "complete" }, { url: f.activeTab.url });
  const result = await f.send("extension.getStatus");
  assert.equal(result.status, "pending");
  assert.equal(result.session.stopReason, "browser_or_extension_restarted");
  assert.equal(f.contentInjections().length, 1);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.data[SESSION_KEY].events.length, 1);
});

test("worker restart recovers interrupted upload and generation as retryable", async () => {
  const f = fixture();
  await f.start();
  f.data[SESSION_KEY].status = "saving";
  f.restartWorker();
  assert.equal((await f.send("extension.getStatus")).status, "pending");
  delete f.data[SESSION_KEY];
  f.data[RESULT_KEY] = { id: "record-1", status: "generating" };
  f.restartWorker();
  const result = await f.send("extension.getStatus");
  assert.equal(result.status, "error");
  assert.match(result.result.error, /interrupted/);
});

test("bounded event limit stops and saves instead of growing storage forever", async () => {
  const f = fixture();
  await f.start();
  f.data[SESSION_KEY].events = Array.from({ length: MAX_EVENTS - 1 }, () => ({ type: "click", ts: 1 }));
  await f.event();
  const body = JSON.parse(f.calls.fetch[0].init.body);
  assert.equal(body.events.length, MAX_EVENTS);
  assert.equal(body.stopReason, "event_limit");
});

test("discard requires a stopped session and deletes only its local capture", async () => {
  const f = fixture({ fetch: async () => { throw new Error("offline"); } });
  await f.start();
  await assert.rejects(f.send("extension.discardCapture"), /Stop capture/);
  await f.send("extension.stopRecording");
  await f.send("extension.discardCapture");
  assert.equal(f.data[SESSION_KEY], undefined);
  assert.equal(f.data[SETTINGS_KEY].enabled, true);
});

const automaticPolicy = { enabled: true, consent: true, target_kind: "ticket-service", target_url: "http://127.0.0.1:8080", use_ai: false, max_tickets: 5 };

function automaticFixture() {
  const transport = { failUpload: false, failStatus: false, target: automaticPolicy.target_url, state: "queued", count: 0, delivered: 0, tombstone: false };
  let policy, savedId, expiresAt;
  const f = fixture({ fetch: async (url, init = {}) => {
    if (url.endsWith("/integrations/ticket-service")) return { ok: true, json: async () => ({ ok: false, url: transport.target }) };
    if (url.endsWith("/integrations")) return { ok: true, json: async () => ({ destinations: [{ kind: "ticket-service", label: "Local ticket service", available: false, configured: true, state: "unavailable", url: transport.target, error: "" }] }) };
    if (url.endsWith("/record")) {
      const payload = JSON.parse(init.body);
      savedId = f.data[SESSION_KEY].recordingId;
      policy = payload.automation;
      expiresAt = (payload.startTime + 86400000) / 1000;
      if (transport.failUpload) throw new Error("offline upload");
      return { ok: true, json: async () => ({ id: savedId || "manual-record" }) };
    }
    if (url.includes("/automation/")) {
      if (transport.failStatus) throw new Error("offline status");
      const action = init.body ? JSON.parse(init.body).action : null;
      const id = url.split("/").at(-1);
      if (transport.tombstone && action === "cancel") return { ok: true, json: async () => ({ ok: true, recording_id: id, status: "cancelled", upload_cancelled: true, delivered_count: 0, execution_authorized: false }) };
      if (action === "cancel") transport.state = "cancelled";
      if (action === "retry") transport.state = "queued";
      return { ok: true, json: async () => ({ ok: true, recording_id: id, status: transport.state, stage: "generation", ticket_count: transport.count,
        delivered_count: transport.delivered, attempts: 1, next_retry_at: null, error: transport.state === "blocked" ? "Safety check blocked delivery" : "",
        deliveries: transport.delivered ? [{ ticket_id: "draft-1", state: "delivered", verified: true, ticket_url: "http://127.0.0.1:8080/?ticket=fixture" }] : [],
        target_url: policy.target_url, target_kind: policy.target_kind, use_ai: policy.use_ai, max_tickets: policy.max_tickets, expires_at: expiresAt, execution_authorized: false }) };
    }
    return { ok: true, json: async () => ({ tickets: [] }) };
  } });
  f.transport = transport;
  f.startAutomatic = (overrides = {}) => f.start({ automation: { ...automaticPolicy, ...overrides } });
  return f;
}

test("automatic delivery requires separate consent and exact known destination and freezes its policy", async () => {
  const f = automaticFixture();
  await assert.rejects(f.startAutomatic({ consent: false }), /fresh consent/);
  await assert.rejects(f.startAutomatic({ max_tickets: 6 }), /five-ticket/);
  await assert.rejects(f.startAutomatic({ target_url: "http://127.0.0.1:9999" }), /destination changed/);
  const policy = { ...automaticPolicy, use_ai: true };
  await f.start({ automation: policy });
  policy.target_url = "http://127.0.0.1:9999";
  policy.use_ai = false;
  assert.deepEqual(f.data[SESSION_KEY].automation, { ...automaticPolicy, use_ai: true });
  assert.match(f.data[SESSION_KEY].recordingId, /^[a-f0-9]{32}$/);
  assert.equal(f.calls.messages[0][1].automationEnabled, true);
});

test("automated save has one generation owner and retains screenshot warnings and immutable policy", async () => {
  const f = automaticFixture();
  await f.startAutomatic();
  f.data[SESSION_KEY].warning = "Screenshots unavailable.";
  f.transport.target = "http://127.0.0.1:9999"; // A later preference cannot retarget this capture.
  const result = await f.send("extension.stopRecording");
  assert.equal(result.status, "automation");
  assert.equal(result.result.automation.status, "queued");
  assert.equal(result.result.warning, "Screenshots unavailable.");
  assert.equal(f.calls.fetch.some((call) => call.url.includes("/tickets/")), false);
  const payload = JSON.parse(f.calls.fetch.find((call) => call.url.endsWith("/record")).init.body);
  assert.deepEqual(payload.automation, automaticPolicy);
  await assert.rejects(f.send("extension.retryGeneration"), /owns draft generation/);
  await assert.rejects(f.start(), /Finish or cancel/);
  assert.equal(f.alarms.get(AUTOMATION_ALARM).periodInMinutes, 1);
});

test("offline automatic upload gets at most three durable retries with unchanged identity, start and policy", async () => {
  const f = automaticFixture(); f.transport.failUpload = true;
  await f.startAutomatic();
  await f.send("extension.stopRecording");
  const first = f.calls.fetch.find((call) => call.url.endsWith("/record")).init.body;
  for (const delay of [60001, 120001, 240001, 600001]) {
    f.restartWorker(); f.advance(delay);
    await f.controller.alarm(AUTOMATION_ALARM);
  }
  const uploads = f.calls.fetch.filter((call) => call.url.endsWith("/record"));
  assert.equal(uploads.length, 4);
  assert.ok(uploads.every((call) => call.init.body === first));
  assert.equal(f.data[SESSION_KEY].uploadAttempts, 4);
  assert.equal(f.data[SESSION_KEY].nextUploadRetryAt, null);
  assert.equal(f.alarms.has(AUTOMATION_ALARM), false);
  await f.send("extension.retryUpload");
  assert.equal(f.calls.fetch.filter((call) => call.url.endsWith("/record")).length, 4);
});

test("expired upload consent is not renewed by worker recovery or manual retry", async () => {
  const f = automaticFixture(); f.transport.failUpload = true;
  await f.startAutomatic(); await f.send("extension.stopRecording");
  f.advance(86400001); f.restartWorker();
  await f.controller.alarm(AUTOMATION_ALARM);
  assert.equal(f.data[SESSION_KEY].nextUploadRetryAt, null);
  assert.match(f.data[SESSION_KEY].error, /24-hour/);
  await f.send("extension.retryUpload");
  assert.equal(f.calls.fetch.filter((call) => call.url.endsWith("/record")).length, 1);
});

test("browser restart or navigation does not silently upload an active automatic capture", async () => {
  for (const interrupt of [async (f) => { delete f.sessionData[BROWSER_KEY]; f.restartWorker(); }, async (f) => f.controller.tabUpdated(7, { url: "https://elsewhere.test" }, {})]) {
    const f = automaticFixture(); await f.startAutomatic(); await f.event();
    await interrupt(f); await f.controller.alarm(AUTOMATION_ALARM);
    assert.equal(f.data[SESSION_KEY].status, "pending");
    assert.equal(f.calls.fetch.some((call) => call.url.endsWith("/record")), false);
    await f.send("extension.retryUpload");
    assert.equal(f.data[RESULT_KEY].status, "automation");
  }
});

test("already-stopped interrupted automatic upload resumes safely after browser restart", async () => {
  const f = automaticFixture(); await f.startAutomatic();
  Object.assign(f.data[SESSION_KEY], { status: "saving", uploadAttempts: 1, endTime: f.data[SESSION_KEY].startTime + 100, stopReason: "user" });
  delete f.sessionData[BROWSER_KEY]; f.restartWorker();
  await f.send("extension.getStatus");
  assert.equal(f.data[SESSION_KEY].status, "pending");
  f.advance(60001); await f.controller.alarm(AUTOMATION_ALARM);
  assert.equal(f.data[RESULT_KEY].automation.status, "queued");
});

test("saved backend automation is polled after worker restart without uploading or generating again", async () => {
  const f = automaticFixture(); await f.startAutomatic(); await f.send("extension.stopRecording");
  f.alarms.clear(); f.restartWorker();
  await f.send("extension.getStatus");
  assert.equal(f.alarms.get(AUTOMATION_ALARM).periodInMinutes, 1);
  f.transport.state = "delivered"; f.transport.count = 1; f.transport.delivered = 1;
  f.advance(60001); await f.controller.alarm(AUTOMATION_ALARM);
  assert.equal(f.data[RESULT_KEY].automation.delivered_count, 1);
  assert.equal(f.alarms.has(AUTOMATION_ALARM), false);
  assert.equal(f.calls.fetch.filter((call) => call.url.endsWith("/record")).length, 1);
  assert.equal(f.calls.fetch.some((call) => call.url.includes("/tickets/")), false);
});

test("lost delivery status stays unknown and does not launch manual generation", async () => {
  const f = automaticFixture(); await f.startAutomatic(); f.transport.failStatus = true;
  await f.send("extension.stopRecording");
  assert.match(f.data[RESULT_KEY].error, /status is unknown/);
  assert.equal(f.data[RESULT_KEY].automation, undefined);
  assert.equal(f.calls.fetch.some((call) => call.url.includes("/tickets/")), false);
  await assert.rejects(f.start(), /Finish or cancel/);
});

test("over-cap proposed drafts are a known terminal block, not an unknown delivery", async () => {
  const f = automaticFixture(); await f.startAutomatic();
  f.transport.state = "blocked"; f.transport.count = 6;
  await f.send("extension.stopRecording");
  assert.equal(f.data[RESULT_KEY].automation.status, "blocked");
  assert.equal(f.data[RESULT_KEY].error, "");
  assert.equal(f.alarms.has(AUTOMATION_ALARM), false);
  await f.start();
});

test("cancelling before upload withdraws delivery, and capture consent revocation cannot send automation", async () => {
  for (const command of ["extension.cancelAutomation", "extension.setEnabled"]) {
    const f = automaticFixture(); await f.startAutomatic();
    await f.send(command, { enabled: false });
    if (command === "extension.cancelAutomation") {
      assert.equal(f.data[SESSION_KEY].automationWithdrawn, true);
      assert.deepEqual(f.data[SESSION_KEY].automation, automaticPolicy);
      await f.send("extension.stopRecording");
    }
    const upload = f.calls.fetch.find((call) => call.url.endsWith("/record"));
    assert.equal(JSON.parse(upload.init.body).automation, undefined);
    assert.equal(f.data[RESULT_KEY].status, "ready");
  }
});

test("cancellation after a lost upload response reconciles stable identity and keeps partial receipts", async () => {
  const f = automaticFixture(); f.transport.failUpload = true;
  await f.startAutomatic(); await f.send("extension.stopRecording");
  const id = f.data[SESSION_KEY].recordingId;
  f.transport.count = 2; f.transport.delivered = 1;
  await f.send("extension.cancelAutomation");
  assert.equal(f.data[SESSION_KEY], undefined);
  assert.equal(f.data[RESULT_KEY].id, id);
  assert.equal(f.data[RESULT_KEY].automation.status, "cancelled");
  assert.equal(f.data[RESULT_KEY].automation.delivered_count, 1);
  assert.match(f.data[RESULT_KEY].automation.deliveries[0].ticket_url, /ticket=fixture/);
  await assert.rejects(f.send("extension.retryAutomation"), /retry-wait/);
});

test("failed cancellation stops uploads but never claims discard cancelled an unknown backend job", async () => {
  const f = automaticFixture(); f.transport.failUpload = true;
  await f.startAutomatic(); await f.send("extension.stopRecording");
  f.transport.failStatus = true; await f.send("extension.cancelAutomation");
  assert.equal(f.data[SESSION_KEY].nextUploadRetryAt, null);
  assert.match(f.data[SESSION_KEY].error, /cancellation is unconfirmed/);
  await assert.rejects(f.send("extension.retryUpload"), /Cancellation is unconfirmed/);
  await assert.rejects(f.send("extension.discardCapture"), /Confirm cancellation/);
  f.advance(60001); await f.controller.alarm(AUTOMATION_ALARM);
  assert.equal(f.calls.fetch.filter((call) => call.url.endsWith("/record")).length, 1);
});

test("durable backend cancellation tombstone makes a never-accepted offline capture safely discardable", async () => {
  const f = automaticFixture(); f.transport.failUpload = true;
  await f.startAutomatic(); await f.send("extension.stopRecording");
  f.transport.tombstone = true; await f.send("extension.cancelAutomation");
  assert.equal(f.data[SESSION_KEY].cancellationConfirmed, true);
  assert.equal(f.data[SESSION_KEY].automationWithdrawn, true);
  assert.equal(f.data[SESSION_KEY].cancelRequested, false);
  await assert.rejects(f.send("extension.retryUpload"), /identity was cancelled/);
  await f.send("extension.discardCapture");
  assert.equal(f.data[SESSION_KEY], undefined);
  await f.start();
});

test("manual retry sends only the existing backend job identity and cannot change its policy", async () => {
  const f = automaticFixture(); await f.startAutomatic({ use_ai: true });
  f.transport.state = "retry_wait"; await f.send("extension.stopRecording");
  const id = f.data[RESULT_KEY].id;
  await f.send("extension.retryAutomation", { target_url: "http://127.0.0.1:9999", use_ai: false });
  const request = f.calls.fetch.at(-1);
  assert.ok(request.url.endsWith(`/automation/${id}`));
  assert.deepEqual(JSON.parse(request.init.body), { action: "retry" });
  assert.equal(f.data[RESULT_KEY].automationPolicy.use_ai, true);
  assert.equal(f.calls.fetch.filter((call) => call.url.endsWith("/record")).length, 1);
});

test("read-only pending upload reconciliation discovers the original job without replay or cancellation", async () => {
  const f = automaticFixture(); f.transport.failUpload = true;
  await f.startAutomatic(); await f.send("extension.stopRecording");
  const id = f.data[SESSION_KEY].recordingId;
  const response = await f.send("extension.refreshAutomation");
  assert.equal(response.result.id, id);
  assert.equal(response.result.automation.status, "queued");
  assert.equal(f.data[SESSION_KEY], undefined);
  assert.equal(f.calls.fetch.at(-1).init.method, undefined);
  assert.equal(f.calls.fetch.filter((call) => call.url.endsWith("/record")).length, 1);
  assert.equal(f.calls.fetch.some((call) => call.url.includes("/tickets/")), false);
});

test("unknown read-only reconciliation preserves pending capture and does not infer safe discard", async () => {
  const f = automaticFixture(); f.transport.failUpload = true;
  await f.startAutomatic(); await f.send("extension.stopRecording");
  f.transport.failStatus = true;
  await f.send("extension.refreshAutomation");
  assert.match(f.data[SESSION_KEY].error, /acceptance is still unknown/);
  await assert.rejects(f.send("extension.discardCapture"), /Confirm cancellation/);
  assert.equal(f.calls.fetch.filter((call) => call.url.endsWith("/record")).length, 1);
});

test("unverified policy, authority, expiry, or receipt counts never replace the last valid backend status", async () => {
  const f = automaticFixture(); await f.startAutomatic(); await f.send("extension.stopRecording");
  const valid = clone(f.data[RESULT_KEY].automation);
  for (const patch of [{ target_url: "http://127.0.0.1:9999" }, { use_ai: true }, { max_tickets: 4 }, { execution_authorized: true }, { expires_at: valid.expires_at + 1 }, { ticket_count: 1, delivered_count: 1, deliveries: [] }]) {
    f.setFetch(async () => ({ ok: true, json: async () => ({ ...valid, ...patch }) }));
    await f.send("extension.refreshAutomation");
    assert.deepEqual(f.data[RESULT_KEY].automation, valid);
    assert.match(f.data[RESULT_KEY].error, /unverified delivery status/);
  }
  assert.equal(f.calls.fetch.some((call) => call.url.includes("/tickets/")), false);
});

test("power defaults Off, clears old consent, and rejects mutation and backend discovery without activating anything", async () => {
  const f = fixture({ powerOn: false });
  assert.equal((await f.send("extension.getStatus")).enabled, false);
  for (const [type, values] of [["extension.startRecording", { tabId: 7, consent: true }], ["extension.setEnabled", { enabled: true }], ["extension.getAutomationTarget", {}], ["extension.retryUpload", {}], ["extension.retryGeneration", {}], ["extension.discardCapture", {}]]) {
    await assert.rejects(f.send(type, values), /Panther is Off/);
  }
  await f.controller.alarm(AUTOMATION_ALARM);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.inject.length, 0);
  assert.equal(f.alarms.size, 0);
  // The controller itself fails closed even if a caller omits the lifecycle dependency.
  const direct = createCaptureController(f.api, async () => { throw new Error("Should not fetch"); });
  await assert.rejects(direct.message({ type: "extension.setEnabled", enabled: true }, control), /Panther is Off/);
});

test("Off freezes active capture without upload, retains events, clears consent and ignores page writes", async () => {
  const f = fixture(); await f.start(); await f.event();
  const id = f.data[SESSION_KEY].sessionId;
  await f.turnOff();
  assert.equal(f.data[SESSION_KEY].status, "pending");
  assert.equal(f.data[SESSION_KEY].sessionId, id);
  assert.equal(f.data[SESSION_KEY].events.length, 1);
  assert.equal(f.data[SESSION_KEY].powerPaused, true);
  assert.equal(f.data[SETTINGS_KEY].enabled, false);
  assert.equal(f.data[SESSION_KEY].nextUploadRetryAt, null);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal((await f.event()).ignored, true);
  assert.equal((await f.send("page.stop", { sessionId: id }, page)).ignored, true);
  assert.equal((await f.send("page.getStatus", {}, page)).status, "pending");
  await f.controller.tabUpdated(7, { status: "complete" }, f.activeTab);
  assert.equal(f.contentInjections().length, 1);
  f.turnOn(); await f.send("extension.getStatus");
  await f.controller.alarm(AUTOMATION_ALARM);
  assert.equal(f.calls.fetch.length, 0);
  await assert.rejects(f.send("extension.retryUpload"), /fresh capture consent/);
  await f.send("extension.setEnabled", { enabled: true });
  assert.equal((await f.send("extension.retryUpload")).status, "ready");
});

test("Off aborts an in-flight upload promptly and late completion cannot trigger generation", async () => {
  let resolveUpload;
  const f = fixture({ fetch: async () => new Promise((resolve) => { resolveUpload = resolve; }) });
  await f.start(); await f.event();
  const stopping = f.send("extension.stopRecording");
  while (!resolveUpload) await new Promise((resolve) => setImmediate(resolve));
  const signal = f.calls.fetch[0].init.signal;
  await f.turnOff(); await stopping;
  assert.equal(signal.aborted, true);
  assert.equal(f.data[SESSION_KEY].status, "pending");
  assert.equal(f.data[SESSION_KEY].events.length, 1);
  assert.equal(f.calls.fetch.length, 1);
  resolveUpload({ ok: true, json: async () => ({ id: "late-receipt" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.data[RESULT_KEY], undefined);
});

test("Off also aborts a stalled JSON response body rather than waiting for it to finish", async () => {
  let resolveBody;
  const f = fixture({ fetch: async () => ({ ok: true, json: () => new Promise((resolve) => { resolveBody = resolve; }) }) });
  await f.start();
  const stopping = f.send("extension.stopRecording");
  while (!resolveBody) await new Promise((resolve) => setImmediate(resolve));
  await f.turnOff(); await stopping;
  assert.equal(f.data[SESSION_KEY].status, "pending");
  resolveBody({ id: "late-body-receipt" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.data[RESULT_KEY], undefined);
});

test("Off aborts generation without claiming its already submitted backend work was undone", async () => {
  let resolveGeneration;
  const f = fixture({ fetch: async (url) => url.endsWith("/record") ? { ok: true, json: async () => ({ id: "saved" }) } : new Promise((resolve) => { resolveGeneration = resolve; }) });
  await f.start();
  const stopping = f.send("extension.stopRecording");
  while (!resolveGeneration) await new Promise((resolve) => setImmediate(resolve));
  await f.turnOff(); await stopping;
  assert.equal(f.data[RESULT_KEY].id, "saved");
  assert.equal(f.data[RESULT_KEY].status, "error");
  assert.equal(f.data[RESULT_KEY].powerPaused, true);
  assert.match(f.data[RESULT_KEY].error, /interrupted|unconfirmed/);
  resolveGeneration({ ok: true, json: async () => ({ tickets: [{ title: "late draft" }] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.data[RESULT_KEY].status, "error");
  assert.equal(f.calls.fetch.length, 2);
});

test("Off clears automatic upload wakeups and explicit On cannot silently resume them", async () => {
  const f = automaticFixture(); f.transport.failUpload = true;
  await f.startAutomatic(); await f.send("extension.stopRecording");
  const before = f.calls.fetch.length;
  assert.equal(f.alarms.has(AUTOMATION_ALARM), true);
  await f.turnOff();
  assert.equal(f.alarms.size, 0);
  f.turnOn(); f.advance(600001);
  await f.send("extension.getStatus"); await f.controller.alarm(AUTOMATION_ALARM);
  assert.equal(f.calls.fetch.length, before);
  assert.equal(f.data[SESSION_KEY].nextUploadRetryAt, null);
  await assert.rejects(f.send("extension.retryUpload"), /fresh capture consent/);
});

test("saved automatic jobs stay locally paused across Off/On until explicit status or action", async () => {
  const f = automaticFixture(); await f.startAutomatic(); await f.send("extension.stopRecording");
  await f.turnOff(); const before = f.calls.fetch.length;
  assert.equal(f.data[RESULT_KEY].powerPaused, true);
  f.turnOn(); f.advance(600001);
  await f.send("extension.getStatus"); await f.controller.alarm(AUTOMATION_ALARM);
  assert.equal(f.calls.fetch.length, before);
  await f.send("extension.refreshAutomation");
  assert.equal(f.calls.fetch.length, before + 1);
  assert.equal(f.calls.fetch.at(-1).init.method, undefined);
  assert.equal(f.data[RESULT_KEY].powerPaused, true);
});

test("Off during destination discovery prevents later injection and capture creation", async () => {
  let resolveTarget;
  const f = fixture({ fetch: () => new Promise((resolve) => { resolveTarget = resolve; }) });
  const starting = f.start({ automation: automaticPolicy });
  const rejected = assert.rejects(starting, /interrupted|Off/);
  while (!resolveTarget) await new Promise((resolve) => setImmediate(resolve));
  await f.turnOff(); await rejected;
  resolveTarget({ ok: true, json: async () => ({ url: automaticPolicy.target_url }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.inject.length, 0);
  assert.equal(f.data[SESSION_KEY], undefined);
});

test("captured goal is supplied only to trusted extension status, including after Save", async () => {
  const f = fixture(); await f.start({goal: "Preserve selection token=private-goal-secret"});
  const popup = await f.send("extension.getStatus");
  assert.match(popup.session.goal, /Preserve selection/);
  assert.doesNotMatch(popup.session.goal, /private-goal-secret/);
  assert.equal(popup.live, undefined);
  assert.equal((await f.send("page.getStatus", {}, page)).session.goal, undefined);
  const forged = await f.send("extension.getStatus", {}, page);
  assert.equal(forged.ok, false); assert.equal(forged.session, undefined);
  await f.event(); await f.send("extension.stopRecording");
  const saved = await f.send("extension.getStatus");
  assert.match(saved.result.goal, /Preserve selection/);
  assert.doesNotMatch(saved.result.goal, /private-goal-secret/);
  const publicSaved = await f.send("page.getStatus", {}, page);
  assert.equal(publicSaved.result.goal, undefined);
  assert.equal(publicSaved.result.live, undefined);
});

test("trusted status reports loaded worker contract without leaking it to page status or rereading manifest", async () => {
  const f = fixture();
  f.api.runtime.getManifest = () => ({version: "1.7.0"});
  f.restartWorker();
  f.api.runtime.getManifest = () => ({version: "9.9.9"});
  const state = await f.send("extension.getStatus");
  assert.deepEqual(state.worker, {capture_contract: 2, app_version: "1.7.0"});
  assert.equal(f.calls.inject.length, 0);
  assert.equal(f.calls.fetch.length, 0);
  const rejected = await f.send("extension.getStatus", {}, page);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.worker, undefined);
  await f.send("extension.startRecording", {tabId: 7, consent: true});
  const pageState = await f.send("page.getStatus", {}, page);
  assert.equal(pageState.worker, undefined);
});
