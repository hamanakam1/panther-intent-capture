import { DIAGNOSTIC_KINDS, REDACT_FIELD_NAMES, REDACT_FIELD_IDS } from "./constants.js";

function looksSecret(key) {
  const k = String(key).toLowerCase();
  return REDACT_FIELD_NAMES.has(k) || REDACT_FIELD_IDS.has(k) || /secret|token|key|pass|cred|auth|cookie/.test(k);
}

function scrubValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = looksSecret(k) ? "***REDACTED***" : scrubValue(v);
    }
    return out;
  }
  return value;
}

/** Recursively redact secret-looking fields from an event payload. */
export function sanitizeEventPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (looksSecret(k)) {
      out[k] = "***REDACTED***";
    } else {
      out[k] = scrubValue(v);
    }
  }
  return out;
}

/** Remove URL credentials, all query values, and secret-bearing fragments. */
export function sanitizeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    if (!/^#\/?[a-z][a-z0-9_/-]{0,100}$/i.test(url.hash) || /secret|token|key|pass|cred|auth|cookie|session/i.test(url.hash)) url.hash = "";
    url.pathname = url.pathname.split("/").map((part, i, parts) =>
      /secret|token|key|pass|cred|auth|cookie|session/i.test(decodeURIComponent(parts[i - 1] || "")) || part.length > 48 ? "REDACTED" : part).join("/");
    return url.href.slice(0, 1000);
  } catch { return ""; }
}

export function sanitizeText(value, max = 120) {
  return String(value ?? "")
    .replace(/\b(?:Bearer\s+)[a-z0-9._~+/-]+=*/gi, "[REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]+/gi, "[REDACTED]")
    .replace(/\b(?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[EMAIL]")
    .replace(/\b[a-z0-9_-]{40,}\b/gi, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

/**
 * Build a page-failure record from an allowlist of fields.
 *
 * Page failures are observations the page itself reported, not proof that a
 * defect exists. The message is the page's own error text, so it is treated as
 * untrusted data: it is scrubbed for common secret shapes, bounded, and never
 * read from page body text. The location is a URL, so it is sanitized like
 * every other captured URL.
 */
export function sanitizeDiagnostic(payload, timestamp = Date.now()) {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload.diagnostic;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  if (!DIAGNOSTIC_KINDS.has(kind)) return null;
  const diagnostic = { kind };
  if (typeof raw.message === "string") {
    const message = sanitizeText(raw.message, 300);
    if (message.trim()) diagnostic.message = message;
  }
  if (typeof raw.source === "string") {
    const source = sanitizeUrl(raw.source);
    if (source) diagnostic.source = source;
  }
  if (kind === "http_error") {
    // An HTTP failure without a readable status is not an HTTP failure. The
    // status is what makes the record meaningful, so it is required.
    if (!Number.isInteger(raw.status) || raw.status < 400 || raw.status > 599) return null;
    diagnostic.status = raw.status;
  }
  if (kind === "uncaught_exception") {
    for (const key of ["line", "column"]) {
      if (Number.isInteger(raw[key]) && raw[key] >= 0 && raw[key] <= 1000000) diagnostic[key] = raw[key];
    }
  }
  // A record with nothing to show is not evidence; drop it rather than
  // delivering an empty line to a reviewer.
  if (!diagnostic.message && !diagnostic.source && diagnostic.status === undefined) return null;
  // A failure keeps the time it actually happened, so the recorded timeline
  // stays truthful. The time comes from the browser's own resource timing,
  // never from the page. It is truncated to whole milliseconds so the
  // extension and the backend record exactly the same instant.
  const observedAt = typeof payload.ts === "number" && Number.isFinite(payload.ts) && payload.ts > 0
    ? Math.trunc(payload.ts) : Math.trunc(timestamp);
  return { type: "diagnostic", ts: observedAt, url: sanitizeUrl(payload.url), diagnostic };
}

/** An allowlist, not a recursive pass-through of untrusted page payloads. */
export function sanitizeCaptureEvent(payload, timestamp = Date.now()) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.type === "diagnostic") return sanitizeDiagnostic(payload, timestamp);
  if (!["click", "change", "submit", "navigation"].includes(payload.type)) return null;
  const event = { type: payload.type, ts: timestamp, url: sanitizeUrl(payload.url) };
  const target = payload.target;
  if (target && typeof target === "object") {
    event.target = {};
    for (const key of ["tag", "role", "id", "type", "dataTab", "dataTicket"]) {
      if (target[key]) event.target[key] = sanitizeText(target[key], 120);
    }
    if (["button", "a"].includes(target.tag) && target.label) event.target.label = sanitizeText(target.label);
    if (target.href) event.target.href = sanitizeUrl(target.href);
    // A click on an element the page never marked as a control. Only the
    // extension's own true flag is kept.
    if (target.inert === true) event.target.inert = true;
  }
  return event;
}
