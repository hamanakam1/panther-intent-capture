import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const script = await readFile(new URL("../extension/content/content.js", import.meta.url), "utf8");

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = {}; this.style = {}; this.textContent = ""; this.control = true; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  hasAttribute(key) { return this.attributes[key] !== undefined; }
  append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
  appendChild(child) { this.append(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  attachShadow(options) { this.shadowOptions = options; this.shadow = new Element("shadow"); return this.shadow; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  // `control: false` models an element the page never marked as a control.
  // `semantic` is a control ancestor; `formAncestor` is a surrounding form.
  closest(selector) {
    if (selector === "form") return this.formAncestor || null;
    if (this.semantic) return this.semantic;
    return this.control === false ? null : this;
  }
  querySelector() { return this.editableChild || null; }
}

function fixture() {
  const messages = [], listeners = {}, windowListeners = {}, timers = new Map(), observers = [];
  let nextTimer = 0, onMessage;
  let status = { ok: true, status: "recording", session: { eventCount: 0 } };
  const root = new Element("html");
  class FakePerformanceObserver {
    constructor(callback) { this.callback = callback; this.options = null; observers.push(this); }
    observe(options) { this.options = options; }
    disconnect() {}
  }
  class FakeCustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  }
  const context = vm.createContext({
    URL, Date, console, CustomEvent: FakeCustomEvent, PerformanceObserver: FakePerformanceObserver,
    performance: { timeOrigin: 1700000000000 },
    getComputedStyle: (element) => ({ cursor: element?.cursor || "" }),
    location: { href: "http://127.0.0.1:8080/#master" },
    document: { documentElement: root, createElement: (tag) => new Element(tag), addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } },
    window: { addEventListener: (type, fn) => { windowListeners[type] = fn; } },
    setInterval: (fn, interval) => { timers.set(++nextTimer, { fn, interval }); return nextTimer; },
    clearInterval: (id) => timers.delete(id),
    chrome: { runtime: {
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      sendMessage: async (message) => {
        messages.push(structuredClone(message));
        if (message.type === "page.getStatus" || message.type === "page.stop") return status;
        return { ok: true, eventCount: messages.filter((item) => item.type === "page.interaction").length };
      }
    } }
  });
  vm.runInContext(script, context);
  return {
    context, root, messages, listeners, windowListeners, timers, observers,
    start(automationEnabled = false, diagnosticNonce = "nonce-1", captureStartMs = 0) { onMessage({ type: "extension.captureStart", sessionId: "session-1", automationEnabled, diagnosticNonce, captureStartMs }, {}, () => {}); },
    stop() { onMessage({ type: "extension.captureStop" }, {}, () => {}); },
    state(value) { status = value; },
    dispatch(type, target, path = [target], isTrusted = true) {
      for (const listener of listeners[type] || []) listener({ target, isTrusted, composedPath: () => path });
    },
    emitResource(entry) {
      const observer = observers[observers.length - 1];
      observer?.callback({ getEntries: () => [{ startTime: 0, ...entry }] });
    },
    tick(interval) { for (const timer of timers.values()) if (timer.interval === interval) timer.fn(); },
    events() { return messages.filter((message) => message.type === "page.interaction"); },
    failures() { return messages.filter((message) => message.type === "page.diagnostic"); }
  };
}

test("content installs once, stays idle until Start, and renders isolated stop/review controls", () => {
  const f = fixture();
  f.dispatch("click", new Element("button"));
  assert.equal(f.events().length, 0);
  vm.runInContext(script, f.context);
  assert.equal(f.listeners.click.length, 1);
  f.start();
  assert.equal(f.events()[0].payload.type, "navigation");
  const panel = f.root.children[0];
  assert.equal(panel.id, "panther-intent-capture-controls");
  assert.equal(panel.shadowOptions.mode, "closed");
  const box = panel.shadow.children[1];
  assert.equal(box.children[0].textContent, "Panther · Capturing");
  assert.equal(box.children[2].children[0].textContent, "Stop & generate");
});

test("automatic capture panel labels Stop honestly and reports historical delivery receipts without execution claims", async () => {
  const f = fixture(); f.start(true);
  const box = f.root.children[0].shadow.children[1];
  assert.equal(box.children[2].children[0].textContent, "Stop & deliver");
  f.state({ ok: true, status: "automation", session: null, result: { id: "rec", automationPolicy: {}, automation: { status: "cancelled", ticket_count: 2, delivered_count: 1 } } });
  f.tick(1000); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(box.children[0].textContent, "Panther · Delivery cancelled");
  assert.match(box.children[1].textContent, /1\/2 historical delivery receipts.*no work execution/);
  assert.equal(box.children[2].children[0].hidden, true);
});

test("nested click targets resolve to dashboard semantic ancestors without recording panel clicks", () => {
  const f = fixture(); f.start();
  const button = new Element("button");
  button.setAttribute("data-tab", "master");
  button.setAttribute("data-ticket", "M-12345");
  button.textContent = "Open";
  const icon = new Element("span"); icon.semantic = button;
  f.dispatch("click", icon);
  const event = f.events().at(-1).payload;
  assert.equal(event.target.tag, "button");
  assert.equal(event.target.dataTab, "master");
  assert.equal(event.target.dataTicket, "M-12345");
  const count = f.events().length;
  f.dispatch("click", new Element("button"), [f.root.children[0]]);
  f.dispatch("click", button, [button], false);
  assert.equal(f.events().length, count);
});

test("change capture never reads input values or typed keys and ignores editable labels", () => {
  const f = fixture(); f.start();
  const input = new Element("input");
  input.setAttribute("type", "password");
  Object.defineProperty(input, "value", { get() { throw new Error("Input value was read"); } });
  f.dispatch("change", input);
  assert.equal(f.events().at(-1).payload.target.label, "");
  assert.equal(f.events().at(-1).payload.target.type, "password");
  const buttonWithEditor = new Element("button");
  buttonWithEditor.editableChild = new Element("textarea");
  buttonWithEditor.textContent = "nested private typed label";
  f.dispatch("click", buttonWithEditor);
  assert.equal(f.events().at(-1).payload.target.label, "");
  assert.equal(f.listeners.keydown, undefined);
  const editableButton = new Element("button");
  editableButton.isContentEditable = true;
  editableButton.textContent = "private typed label";
  f.dispatch("click", editableButton);
  assert.equal(f.events().at(-1).payload.target.label, "");
});

test("hash and pushState-style route changes are captured once with private query removed", () => {
  const f = fixture(); f.start();
  f.context.location.href = "http://127.0.0.1:8080/?token=secret#work-board";
  f.windowListeners.hashchange();
  assert.equal(f.events().at(-1).payload.url, "http://127.0.0.1:8080/#work-board");
  const count = f.events().length;
  f.tick(500);
  assert.equal(f.events().length, count);
  f.context.location.href = "http://127.0.0.1:8080/settings?password=secret";
  f.tick(500);
  assert.equal(f.events().at(-1).payload.url, "http://127.0.0.1:8080/settings");
});

test("Stop disables event capture and Hide removes only controls without stopping capture", () => {
  const f = fixture(); f.start();
  const box = f.root.children[0].shadow.children[1];
  box.children[2].children[2].listeners.click();
  assert.equal(f.root.children.length, 0);
  f.dispatch("click", new Element("button"));
  assert.equal(f.events().length, 2);
  f.stop();
  f.dispatch("click", new Element("button"));
  assert.equal(f.events().length, 2);
  assert.equal([...f.timers.values()].filter((timer) => timer.interval === 500).length, 0);
});

test("floating panel exposes generating and ready draft state and links to review", async () => {
  const f = fixture(); f.start();
  const box = f.root.children[0].shadow.children[1];
  f.state({ ok: true, status: "generating", result: { id: "rec", eventCount: 3 } });
  f.tick(1000); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(box.children[0].textContent, "Panther · Generating drafts…");
  f.state({ ok: true, status: "ready", result: { id: "rec", eventCount: 3, ticketCount: 2 } });
  f.tick(1000); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(box.children[0].textContent, "Panther · Drafts ready");
  assert.equal(box.children[2].children[1].hidden, false);
  box.children[2].children[1].listeners.click();
  assert.equal(f.messages.at(-1).type, "page.openReview");
});

test("a click on something that is not a control is kept only when it looks interactive", () => {
  const f = fixture(); f.start();
  const baseline = f.events().length;
  // An ordinary click on empty space is not evidence of anything.
  const plain = new Element("div");
  plain.control = false;
  f.dispatch("click", plain);
  assert.equal(f.events().length, baseline);
  // An element the page styled as clickable is kept, and is marked as such.
  const pointer = new Element("div");
  pointer.control = false;
  pointer.cursor = "pointer";
  pointer.textContent = "private page text";
  f.dispatch("click", pointer);
  const event = f.events().at(-1).payload;
  assert.equal(f.events().length, baseline + 1);
  assert.equal(event.type, "click");
  assert.equal(event.target.inert, true);
  assert.equal(event.target.tag, "div");
  assert.equal(event.target.label, undefined);
  assert.doesNotMatch(JSON.stringify(event), /private page text/);
  // A focusable element is kept too.
  const focusable = new Element("span");
  focusable.control = false;
  focusable.setAttribute("tabindex", "0");
  f.dispatch("click", focusable);
  assert.equal(f.events().at(-1).payload.target.inert, true);
  // A control is never marked as a non-control.
  f.dispatch("click", new Element("button"));
  assert.equal(f.events().at(-1).payload.target.inert, undefined);
});

test("a click inside a form but not on a control is marked without losing the form", () => {
  const f = fixture(); f.start();
  const form = new Element("form");
  const inner = new Element("div");
  inner.control = false;
  inner.cursor = "pointer";
  inner.formAncestor = form;
  f.dispatch("click", inner);
  const event = f.events().at(-1).payload;
  assert.equal(event.target.tag, "form");
  assert.equal(event.target.inert, true);
});

test("page failures are reported as bounded observations and never read page text", () => {
  const f = fixture(); f.start();
  const image = new Element("img");
  image.src = "http://127.0.0.1:8080/missing.png";
  f.dispatch("error", image);
  const failure = f.failures().at(-1);
  assert.equal(failure.payload.type, "diagnostic");
  assert.equal(failure.payload.diagnostic.kind, "resource_error");
  assert.equal(failure.payload.diagnostic.source, "http://127.0.0.1:8080/missing.png");
  assert.equal(failure.payload.diagnostic.message, "A img resource failed to load");
  // The failure carries no page text, no typed value and no control target.
  assert.deepEqual(Object.keys(failure.payload.diagnostic).sort(), ["kind", "message", "source"]);
  assert.equal(failure.payload.target, undefined);
});

test("an HTTP error response is reported with its status and no other request detail", () => {
  const f = fixture(); f.start();
  f.emitResource({ name: "http://127.0.0.1:8080/api/tickets", responseStatus: 500, initiatorType: "fetch" });
  f.emitResource({ name: "http://127.0.0.1:8080/api/ok", responseStatus: 200, initiatorType: "fetch" });
  f.emitResource({ name: "http://127.0.0.1:8080/opaque", responseStatus: 0, initiatorType: "fetch" });
  const failures = f.failures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].payload.diagnostic.kind, "http_error");
  assert.equal(failures[0].payload.diagnostic.status, 500);
  assert.equal(failures[0].payload.diagnostic.source, "http://127.0.0.1:8080/api/tickets");
});

test("the page's own uncaught failures are relayed only for the current session nonce", () => {
  const f = fixture(); f.start(false, "nonce-1");
  for (const listener of f.listeners["panther-diagnostic"] || []) {
    listener({ detail: { nonce: "wrong-nonce", kind: "uncaught_exception", message: "forged" } });
    listener({ detail: { nonce: "nonce-1", kind: "uncaught_exception", message: "TypeError: x is not a function", source: "http://127.0.0.1:8080/app.js", line: 12, column: 3 } });
    listener({ detail: { nonce: "nonce-1", kind: "unhandled_rejection", message: "rejected" } });
  }
  const failures = f.failures();
  assert.equal(failures.length, 2);
  assert.equal(failures[0].payload.diagnostic.kind, "uncaught_exception");
  assert.equal(failures[0].payload.diagnostic.message, "TypeError: x is not a function");
  assert.equal(failures[0].payload.diagnostic.line, 12);
  assert.equal(failures[1].payload.diagnostic.kind, "unhandled_rejection");
  assert.doesNotMatch(JSON.stringify(failures), /forged/);
});

test("a failure that happened before the capture began stays outside the consented window", () => {
  const f = fixture();
  f.start(false, "nonce-1", 1700000000000);
  // A page-load failure from before the capture started.
  f.emitResource({ name: "http://127.0.0.1:8080/api/early", responseStatus: 500, initiatorType: "fetch", startTime: -5000 });
  assert.equal(f.failures().length, 0);
  // A failure during the capture is kept, and carries its own real time so
  // the recorded timeline stays truthful.
  f.emitResource({ name: "http://127.0.0.1:8080/api/late", responseStatus: 500, initiatorType: "fetch", startTime: 2000 });
  assert.equal(f.failures().length, 1);
  assert.equal(f.failures()[0].payload.ts, 1700000002000);
  assert.equal(f.failures()[0].payload.diagnostic.source, "http://127.0.0.1:8080/api/late");
});

test("page failures stop with capture and are bounded per session", () => {
  const f = fixture(); f.start();
  for (let index = 0; index < 80; index++) {
    f.emitResource({ name: `http://127.0.0.1:8080/api/${index}`, responseStatus: 500, initiatorType: "fetch" });
  }
  assert.ok(f.failures().length <= 50, `expected a bounded number of failures, got ${f.failures().length}`);
  f.stop();
  const before = f.failures().length;
  f.emitResource({ name: "http://127.0.0.1:8080/api/after", responseStatus: 500, initiatorType: "fetch" });
  assert.equal(f.failures().length, before);
});
