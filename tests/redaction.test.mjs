import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeEventPayload, sanitizeCaptureEvent, sanitizeUrl } from "../extension/shared/redaction.js";

test("redacts secret field names and nested fields", () => {
  const out = sanitizeEventPayload({ password: "hunter2", token: "abc", user: { api_key: "sk-123", email: "a@b.c" } });
  assert.equal(out.password, "***REDACTED***");
  assert.equal(out.token, "***REDACTED***");
  assert.equal(out.user.api_key, "***REDACTED***");
});
test("capture allowlist excludes typed keys and input values", () => {
  const out = sanitizeCaptureEvent({ type: "change", ts: 100, key: "a", value: "private", target: { tag: "input", value: "private", label: "private" } }, 100);
  assert.ok(out);
  assert.equal(JSON.stringify(out).includes("private"), false);
  assert.equal(out.key, undefined);
});
test("URLs retain dashboard routes and discard credentials and query", () => {
  const out = sanitizeUrl("http://user:pass@127.0.0.1:8080/?token=secret#cockpit");
  assert.equal(out, "http://127.0.0.1:8080/#cockpit");
});
test("page failures keep only allowlisted bounded fields", () => {
  const out = sanitizeCaptureEvent({ type: "diagnostic", ts: 100, url: "https://app.test/page?token=private",
    diagnostic: { kind: "http_error", message: "A request returned HTTP 500", source: "https://app.test/api/tickets?token=private", status: 500, private: "never" } }, 100);
  assert.deepEqual(out.diagnostic, { kind: "http_error", message: "A request returned HTTP 500", source: "https://app.test/api/tickets", status: 500 });
  assert.equal(out.url, "https://app.test/page");
  assert.equal(out.ts, 100);
  assert.doesNotMatch(JSON.stringify(out), /private|never/);
});
test("page failures are dropped when unknown, empty or out of range", () => {
  for (const diagnostic of [
    { kind: "unknown_kind", message: "x" },
    { kind: "http_error" },
    { kind: "http_error", message: "x", status: 200 },
    { message: "no kind" }
  ]) {
    assert.equal(sanitizeCaptureEvent({ type: "diagnostic", ts: 1, diagnostic }, 1), null);
  }
  assert.equal(sanitizeCaptureEvent({ type: "diagnostic", ts: 1, diagnostic: { kind: "http_error", message: "x", status: 500 } }, 1).diagnostic.status, 500);
  // A field that does not belong to the kind is dropped, not carried.
  const extra = sanitizeCaptureEvent({ type: "diagnostic", ts: 1, diagnostic: { kind: "http_error", message: "x", status: 500, line: 4 } }, 1);
  assert.equal(extra.diagnostic.line, undefined);
  const position = sanitizeCaptureEvent({ type: "diagnostic", ts: 1, diagnostic: { kind: "uncaught_exception", message: "boom", line: 12, column: 3 } }, 1);
  assert.equal(position.diagnostic.line, 12);
  assert.equal(position.diagnostic.column, 3);
});
test("page failure messages are scrubbed like every other captured text", () => {
  const out = sanitizeCaptureEvent({ type: "diagnostic", ts: 1, diagnostic: { kind: "uncaught_exception", message: "failed for user@example.test with Bearer abcdef123456" } }, 1);
  assert.doesNotMatch(out.diagnostic.message, /user@example\.test|abcdef123456/);
});
