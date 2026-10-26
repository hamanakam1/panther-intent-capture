export const BACKEND_ORIGIN = "http://127.0.0.1:7890";
export const STORAGE_ROOT_KEY = "extension.local";

// Compatibility is advertised by the running process, never inferred from a
// checkout or a version number alone. Keep this module on the legacy UI allowlist.
export function backendReadiness(health) {
  const connected = health?.status === "ok" && health?.service === "panther-intent-capture-backend";
  const version = typeof health?.app_version === "string" && /^\d+\.\d+\.\d+$/.test(health.app_version) ? health.app_version : "unknown";
  const ready = connected && version !== "unknown" && health.schema_version === "1.1" && health.bundle_schema_version === "1.2"
    && Array.isArray(health.capabilities) && ["review-edit-persistence", "intent-bundle-1.2"].every(capability => health.capabilities.includes(capability));
  return {ready, connected, version};
}

export function workerReadiness(worker) {
  return worker?.capture_contract === 2 && typeof worker.app_version === "string" && /^\d+\.\d+\.\d+$/.test(worker.app_version);
}

export const UPDATE_GUIDANCE = "Finish capture → Off → reload extension → On, then Refresh. Retry any retained upload before starting another capture. Nothing updates automatically.";

export const REDACT_FIELD_NAMES = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "apikey",
  "api_key",
  "access_key",
  "secret_key",
  "token",
  "authorization",
  "credential",
  "private_key",
  "session_id",
  "auth",
  "cookie"
]);

export const REDACT_FIELD_IDS = new Set([
  "password",
  "passwd",
  "secret",
  "apikey",
  "api_key",
  "access_key",
  "secret_key",
  "token",
  "credential",
  "private_key",
  "session_id"
]);

/**
 * Page-failure channels Panther can observe without reading page text, typed
 * values or keystrokes. The backend mirrors this set exactly; a new kind needs
 * a matching backend change and a redaction-parity update.
 *
 * - uncaught_exception: the page threw an uncaught error.
 * - unhandled_rejection: the page left a promise rejection unhandled.
 * - http_error: a request the page made returned an HTTP error status.
 * - resource_error: a subresource the page loaded failed to load.
 */
export const DIAGNOSTIC_KINDS = new Set([
  "uncaught_exception",
  "unhandled_rejection",
  "http_error",
  "resource_error"
]);
