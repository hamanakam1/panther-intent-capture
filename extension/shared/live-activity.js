import { DIAGNOSTIC_KINDS } from "./constants.js";
import { sanitizeCaptureEvent, sanitizeText, sanitizeUrl } from "./redaction.js";

const SOURCE_WINDOW = 30;
const VISIBLE_EVENTS = 12;
const MAX_PATTERNS = 5;
const EVENT_TYPES = new Set(["click", "change", "submit", "navigation", "diagnostic"]);

// Stored sessions are normally structured-cloned data. Do not invoke getters
// or coercion hooks when examining malformed/restored state either.
function field(value, key) {
  if (!value || typeof value !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; }
  catch { return undefined; }
}

function text(value, max) {
  return typeof value === "string" ? sanitizeText(value.slice(0, 8192), max).trim() : "";
}

function url(value) {
  return typeof value === "string" ? text(sanitizeUrl(value.slice(0, 4096)), 500) : "";
}

function timestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : null;
}

/**
 * Project a page failure into the bounded live view.
 *
 * A failure is what the page itself reported. It is shown as an observation of
 * the page's error stream, never as a confirmed defect, and it carries no
 * control identity.
 */
function projectDiagnostic(raw, seq) {
  const diagnostic = field(raw, "diagnostic");
  const kind = text(field(diagnostic, "kind"), 40);
  if (!DIAGNOSTIC_KINDS.has(kind)) return null;
  const message = text(field(diagnostic, "message"), 300);
  const source = url(field(diagnostic, "source"));
  const status = field(diagnostic, "status");
  const payload = { type: "diagnostic", url: url(field(raw, "url")), diagnostic: { kind } };
  if (message) payload.diagnostic.message = message;
  if (source) payload.diagnostic.source = source;
  if (Number.isInteger(status) && status >= 400 && status <= 599) payload.diagnostic.status = status;
  const clean = sanitizeCaptureEvent(payload, timestamp(field(raw, "ts")));
  if (!clean) return null;
  const labels = {
    uncaught_exception: `Page error: ${message || "an uncaught exception was reported"}`,
    unhandled_rejection: `Unhandled page rejection: ${message || "the page left a rejection unhandled"}`,
    http_error: `Request failed: HTTP ${clean.diagnostic.status}${source ? " at " + source : ""}`,
    resource_error: `A resource failed to load${source ? ": " + source : ""}`
  };
  return {
    public: { seq, ts: clean.ts, type: "diagnostic", label: text(labels[kind], 140), url: clean.url },
    control: {},
    identity: ""
  };
}

function projectEvent(raw, seq) {
  const type = field(raw, "type");
  if (!EVENT_TYPES.has(type)) return null;
  if (type === "diagnostic") return projectDiagnostic(raw, seq);
  const target = field(raw, "target");
  const safeTarget = {};
  for (const key of ["tag", "role", "id", "type", "dataTab", "dataTicket", "label"]) {
    const value = text(field(target, key), 120);
    if (value) safeTarget[key] = value;
  }
  safeTarget.href = url(field(target, "href"));
  // A click on an element the page never marked as a control.
  if (field(target, "inert") === true) safeTarget.inert = true;
  // Reuse the capture allowlist: input labels, values, typed keys and arbitrary
  // target properties must not become a second, less-private capture channel.
  const clean = sanitizeCaptureEvent({ type, url: url(field(raw, "url")), target: safeTarget }, timestamp(field(raw, "ts")));
  if (!clean) return null;
  clean.url = url(clean.url);
  const control = clean.target || {};
  const name = control.label ? `“${control.label}”` : control.tag === "a" ? "a link" : control.tag === "button" || control.role === "button" ? "a button" : control.role === "tab" ? "a tab" : "a control";
  const labels = {
    click: `Clicked ${name}`,
    change: control.tag === "select" ? "Changed a selection (value not captured)" : control.type === "checkbox" ? "Changed a checkbox (value not captured)" : "Changed a field (value not captured)",
    submit: "Submitted a form (result not observed)",
    navigation: clean.url ? `Visited ${clean.url}` : "Navigation observed (address unavailable)"
  };
  // A label alone cannot identify a control. Reject masked/truncated identity
  // fields, which could otherwise collapse different controls into one group.
  let incompleteIdentity = false;
  const identifiers = ["id", "dataTab", "dataTicket"].map((key) => {
    const original = field(target, key);
    const value = control[key] || "";
    if (original === undefined || original === "") return "";
    if (typeof original !== "string" || original.length > 120 || !value || /REDACTED|\[EMAIL\]/i.test(value)) {
      incompleteIdentity = true;
      return "";
    }
    return value;
  });
  const identity = clean.url && !incompleteIdentity && identifiers.some(Boolean) ? JSON.stringify([clean.url, control.tag || "", control.role || "", ...identifiers]) : "";
  return {
    public: { seq, ts: clean.ts, type, label: text(labels[type], 140), url: clean.url },
    control,
    identity
  };
}

function repeatPattern(events, type) {
  const required = 3;
  for (let end = events.length - 1; end >= 0; end--) {
    const latest = events[end];
    if (latest.public.type !== type || !latest.identity || latest.public.ts === null) continue;
    const repeated = events.slice(0, end + 1).filter((event) => event.public.type === type && event.identity === latest.identity && event.public.ts !== null && event.public.ts <= latest.public.ts && latest.public.ts - event.public.ts <= 10000);
    if (repeated.length < required) continue;
    return {
      kind: type === "click" ? "repeated_clicks" : "repeated_changes",
      title: type === "click" ? "Repeated clicks on one control" : "Repeated changes to one field",
      detail: type === "click" ? `${repeated.length} clicks within 10 seconds may indicate an unclear or unresponsive control, or intentional repetition. No failure is verified.` : `${repeated.length} changes within 10 seconds may indicate adjustment or uncertainty. No field values or validation outcome were captured.`,
      evidence: repeated.map((event) => event.public.seq),
      hypothesis: true
    };
  }
  return null;
}

/**
 * Surface the page's own reported failures.
 *
 * The page's error stream is evidence about the page, not proof that the
 * person hit that defect. The wording keeps that difference visible.
 */
function errorPattern(events) {
  const failures = events.filter((event) => event.public.type === "diagnostic");
  if (!failures.length) return null;
  return {
    kind: "page_error",
    title: failures.length === 1 ? "The page reported a failure" : `The page reported ${failures.length} failures`,
    detail: "The page's own error stream reported a failure during this capture. It is an observation of what the page said, not a verified defect and not a reproduction.",
    evidence: failures.map((event) => event.public.seq),
    hypothesis: true
  };
}

/**
 * Surface clicks that landed on something the page never marked as a control.
 *
 * The element looked interactive to the person, so the control may be missing
 * a role or an accessible name. The wording keeps that a possibility.
 */
function nonControlPattern(events) {
  const inert = events.filter((event) => event.public.type === "click" && event.control.inert === true);
  if (!inert.length) return null;
  return {
    kind: "non_control_click",
    title: "Clicked an element that is not a control",
    detail: `${inert.length} click(s) landed on an element the page never marked as a control, although it presented itself as interactive. The control may be missing a role or an accessible name, or the click may have had no effect. No failure is verified.`,
    evidence: inert.map((event) => event.public.seq),
    hypothesis: true
  };
}

function navigationPattern(events) {
  const navigations = events.filter((event) => event.public.type === "navigation" && event.public.url);
  for (let end = navigations.length - 1; end >= 2; end--) {
    const [a, b, back] = navigations.slice(end - 2, end + 1);
    if (a.public.url === back.public.url && a.public.url !== b.public.url) {
      return {
        kind: "navigation_loop",
        title: "Returned to a previous view",
        detail: "An A → B → A navigation sequence may indicate searching between views or ordinary comparison. No navigation defect is verified.",
        evidence: [a.public.seq, b.public.seq, back.public.seq],
        hypothesis: true
      };
    }
  }
  return null;
}

function intent(events) {
  const meanings = [
    [/\b(search|filter|sort|find)\b/i, "trying to find or narrow down items"],
    [/\b(save|submit|update|apply|confirm)\b/i, "trying to apply or save changes"],
    [/\b(create|add|new)\b/i, "trying to create or add an item"],
    [/\b(edit|rename)\b/i, "trying to change an existing item"],
    [/\b(delete|remove|archive)\b/i, "trying to remove or archive an item"],
    [/\b(settings|preferences|configure)\b/i, "trying to adjust settings"]
  ];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const semantics = [event.control.label, event.control.id, event.control.dataTab, event.control.type].filter(Boolean).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
    for (const [pattern, meaning] of meanings) {
      if (pattern.test(semantics)) return `Tentative interpretation from recent controls: ${meaning}. Outcome unknown.`;
    }
    if (event.public.type === "submit") return "Tentative interpretation: trying to send a form. Submission success is not observed.";
  }
  const latest = events.at(-1)?.public.type;
  if (latest === "navigation") return "Tentative interpretation: exploring a page or moving between views. The intended task is not yet clear.";
  if (latest === "change") return "Tentative interpretation: adjusting a field. Its value and the intended outcome are not captured.";
  if (latest === "diagnostic") return "Tentative interpretation: the page reported a failure during this capture. The intended task is not yet clear.";
  if (latest === "click") return "A control was clicked, but there is not enough evidence to infer the intended task.";
  return "Waiting for consented interactions before inferring a task.";
}

/**
 * Deterministic, bounded explanation of a consented stored capture. This is
 * local rules-based interpretation, not model inference or a success signal.
 * Power/freshness/historical labels remain the caller's responsibility.
 */
export function buildLiveActivity(session) {
  try {
    if (field(session, "consent") !== true) return null;
    const source = field(session, "events");
    const eventCount = Array.isArray(source) ? field(source, "length") : 0;
    const events = [];
    for (let i = Math.max(0, eventCount - SOURCE_WINDOW); i < eventCount; i++) {
      const event = projectEvent(field(source, String(i)), i + 1);
      if (event) events.push(event);
    }
    const visible = events.slice(-VISIBLE_EVENTS);
    const recentEvents = visible.map((event) => event.public);
    const latest = recentEvents.at(-1);
    const goal = text(field(session, "goal"), 300);
    return {
      sessionId: text(field(session, "sessionId"), 120),
      eventCount,
      observedAt: [...recentEvents].reverse().find((event) => event.ts !== null)?.ts ?? null,
      goal,
      page: { title: text(field(session, "title"), 120), url: latest?.url || url(field(session, "url")) },
      recentEvents,
      summary: latest ? text(`${latest.label}. ${eventCount} captured event${eventCount === 1 ? "" : "s"} in this session. Outcomes are not verified.`, 300) : "No page interactions have been captured yet.",
      inferredIntent: intent(visible),
      patterns: [errorPattern(visible), nonControlPattern(visible), repeatPattern(visible, "click"), navigationPattern(visible), repeatPattern(visible, "change")].filter(Boolean),
      source: "rules",
      windowStartSeq: recentEvents[0]?.seq || 0
    };
  } catch {
    // Proxies and revoked objects cannot be restored from extension storage,
    // but fail closed rather than accidentally projecting arbitrary objects.
    return null;
  }
}

/** Revalidate a persisted projection without trusting its historical schema. */
export function sanitizeLiveActivity(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || field(value, "source") !== "rules") return null;
    const rawSessionId = field(value, "sessionId");
    const eventCount = field(value, "eventCount");
    if (typeof rawSessionId !== "string" || !rawSessionId.trim() || rawSessionId.length > 80 ||
        !Number.isSafeInteger(eventCount) || eventCount < 0 || eventCount > 2000) return null;
    const source = field(value, "recentEvents");
    const count = Array.isArray(source) ? field(source, "length") : 0;
    const bySequence = new Map();
    for (let i = Math.max(0, count - SOURCE_WINDOW); i < count; i++) {
      const raw = field(source, String(i));
      const seq = field(raw, "seq"), type = field(raw, "type");
      if (!Number.isSafeInteger(seq) || seq < 1 || seq > eventCount || !EVENT_TYPES.has(type)) continue;
      const label = text(field(raw, "label"), 140);
      if (!label) continue;
      bySequence.set(seq, { seq, ts: timestamp(field(raw, "ts")), type, label, url: url(field(raw, "url")) });
    }
    const recentEvents = [...bySequence.values()].sort((a, b) => a.seq - b.seq).slice(-VISIBLE_EVENTS);
    const visible = new Set(recentEvents.map((event) => event.seq));
    const rawPatterns = field(value, "patterns");
    const patterns = [];
    const patternKinds = new Set(["page_error", "non_control_click", "repeated_clicks", "repeated_changes", "navigation_loop"]);
    const patternCount = Array.isArray(rawPatterns) ? Math.min(field(rawPatterns, "length"), MAX_PATTERNS) : 0;
    for (let i = 0; i < patternCount; i++) {
      const raw = field(rawPatterns, String(i));
      const kind = field(raw, "kind");
      if (!patternKinds.has(kind) || field(raw, "hypothesis") !== true) continue;
      const title = text(field(raw, "title"), 120), detail = text(field(raw, "detail"), 300);
      const rawEvidence = field(raw, "evidence");
      const evidence = new Set();
      const evidenceCount = Array.isArray(rawEvidence) ? Math.min(field(rawEvidence, "length"), VISIBLE_EVENTS) : 0;
      for (let j = 0; j < evidenceCount; j++) {
        const seq = field(rawEvidence, String(j));
        if (visible.has(seq)) evidence.add(seq);
      }
      if (title && detail && evidence.size) patterns.push({ kind, title, detail, evidence: [...evidence].sort((a, b) => a - b), hypothesis: true });
    }
    const page = field(value, "page");
    return {
      sessionId: text(rawSessionId, 80), eventCount,
      observedAt: [...recentEvents].reverse().find((event) => event.ts !== null)?.ts ?? null,
      goal: text(field(value, "goal"), 300),
      page: { title: text(field(page, "title"), 120), url: url(field(page, "url")) },
      recentEvents,
      summary: text(field(value, "summary"), 300),
      inferredIntent: text(field(value, "inferredIntent"), 300),
      patterns, source: "rules", windowStartSeq: recentEvents[0]?.seq || 0
    };
  } catch {
    return null;
  }
}
