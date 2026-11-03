import { BACKEND_ORIGIN } from "./constants.js";
import { sanitizeCaptureEvent, sanitizeText, sanitizeUrl } from "./redaction.js";
import { trustedExtensionControl, trustedMonitorControl } from "./lifecycle.js";
import { buildLiveActivity, sanitizeLiveActivity } from "./live-activity.js";

export const SESSION_KEY = "extension.capture.session";
export const RESULT_KEY = "extension.capture.result";
export const SETTINGS_KEY = "extension.local.state";
export const BROWSER_KEY = "extension.capture.browserActive";
export const MAX_EVENTS = 2000;
export const AUTOMATION_ALARM = "panther.automation";
const CONSENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOAD_ATTEMPTS = 4; // One user stop plus at most three automatic retries.
const AUTOMATION_STATES = new Set(["queued", "generating", "delivering", "retry_wait", "delivered", "blocked", "cancelled"]);
const TERMINAL_AUTOMATION_STATES = new Set(["delivered", "blocked", "cancelled"]);
const MAX_SCREENSHOTS = 5;
const MAX_SCREENSHOT_BYTES = 300000;
const SCREENSHOT_COOLDOWN_MS = 3000;
const HEADERS = { "Content-Type": "application/json", "X-Panther-Client": "extension-v1" };
const MONITOR_COMMANDS = new Set(["extension.getStatus", "extension.stopRecording", "extension.cancelAutomation", "extension.openReview", "extension.analyzeLive", "extension.cancelLiveAnalysis"]);

/**
 * Install the main-world relay that reports the page's own uncaught failures.
 *
 * An isolated world cannot observe the page's uncaught exceptions or
 * unhandled rejections, so this small relay is injected into the page's world.
 * It forwards a bounded message and a location only. It never reads page
 * text, input values or typed keys, and it holds no extension privilege: the
 * page can already say anything it likes in its own error stream, so Panther
 * treats what arrives here as an observation and never as a verified defect.
 */
export function pantherDiagnosticRelay(nonce) {
  if (!nonce || typeof nonce !== "string") return;
  const guard = "__pantherDiagnostic" + nonce;
  if (globalThis[guard]) return;
  globalThis[guard] = true;
  const relay = (kind, payload) => {
    try {
      document.dispatchEvent(new CustomEvent("panther-diagnostic", { detail: { nonce, kind, ...payload } }));
    } catch { /* The page changed under us; capture continues without it. */ }
  };
  globalThis.addEventListener("error", (event) => {
    relay("uncaught_exception", {
      message: String(event.message || ""),
      source: String(event.filename || ""),
      line: Number.isInteger(event.lineno) ? event.lineno : 0,
      column: Number.isInteger(event.colno) ? event.colno : 0
    });
  });
  globalThis.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    relay("unhandled_rejection", {
      message: String((reason && reason.message) || reason || ""),
      source: ""
    });
  });
}

/** Persist before acknowledging: a Chromium service worker can stop at any time. */
export function createCaptureController(api, fetcher, now = Date.now, { isPowered = () => false } = {}) {
  let queue = Promise.resolve();
  let pollQueued = false;
  let frozen = false;
  let authorityEpoch = 0;
  let liveRequest = null;
  let lastLiveRequestAt = 0;
  let lastLiveSession = "";
  let lastLiveRevision = 0;
  const requests = new Set();
  const powered = () => !frozen && isPowered() === true;
  const requirePower = () => { if (!powered()) throw new Error("Panther is Off. Turn On explicitly before capturing or changing recordings."); };
  const request = async (url, init = {}) => {
    requirePower();
    const token = authorityEpoch;
    const controller = new AbortController();
    requests.add(controller);
    const forwardAbort = () => controller.abort();
    init.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (init.signal?.aborted) controller.abort();
    let abortListener;
    try {
      const interrupted = new Promise((_, reject) => {
        abortListener = () => reject(new Error("Request interrupted. Panther may be Off; any accepted upload or delivery must be checked, not assumed undone."));
        controller.signal.addEventListener("abort", abortListener, { once: true });
        if (controller.signal.aborted) abortListener();
      });
      // Keep cancellation ownership until JSON is consumed, not merely until
      // response headers arrive; a stalled body must not delay Turn Off.
      const operation = (async () => {
        const response = await fetcher(url, { ...init, signal: controller.signal });
        const body = response.ok ? await response.json() : null;
        return { ok: response.ok, status: response.status, json: async () => body };
      })();
      const response = await Promise.race([operation, interrupted]);
      if (token !== authorityEpoch) throw new Error("Panther turned Off during the request. Check whether the backend accepted it after turning On.");
      requirePower();
      return response;
    } finally {
      requests.delete(controller);
      init.signal?.removeEventListener("abort", forwardAbort);
      controller.signal.removeEventListener("abort", abortListener);
    }
  };
  const serial = (task) => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };
  const read = async (key) => (await api.storage.local.get(key))[key];
  const save = async (session) => api.storage.local.set({ [SESSION_KEY]: session });
  const saveResult = async (result) => api.storage.local.set({ [RESULT_KEY]: result });
  const tabMessage = async (tabId, message) => {
    try { return await api.tabs.sendMessage(tabId, message, { frameId: 0 }); } catch { return null; }
  };
  const audit = async (action, extra = {}) => {
    const key = "extension.consent.log";
    const log = await read(key) || [];
    await api.storage.local.set({ [key]: [...log, { ts: now(), action, ...extra }].slice(-1000) });
  };
  const badge = async (session) => {
    if (!session) return;
    try {
      await api.action.setBadgeText({ tabId: session.tabId, text: session.status === "recording" ? "REC" : "!" });
      await api.action.setBadgeBackgroundColor({ tabId: session.tabId, color: session.status === "recording" ? "#dc2626" : "#b45309" });
    } catch { /* The captured tab may have been closed. */ }
  };
  const status = async (includeLive = false) => {
    const session = await read(SESSION_KEY);
    const settings = await read(SETTINGS_KEY) || {};
    const result = await read(RESULT_KEY) || null;
    // The page panel never receives the goal, action feed or live interpretation.
    const publicResult = result ? { ...result } : null;
    if (publicResult) delete publicResult.live;
    return {
      ok: true, enabled: settings.enabled === true,
      status: session?.status || result?.status || "idle",
      session: session ? {
        sessionId: session.sessionId, tabId: session.tabId, startTime: session.startTime,
        eventCount: session.events.length, screenshotCount: session.screenshots.length,
        screenshotsConsent: session.screenshotConsent === true,
        error: session.error || "", warning: session.warning || "", stopReason: session.stopReason || "", url: session.url,
        automation: session.automation || null, automationWithdrawn: session.automationWithdrawn === true,
        powerPaused: session.powerPaused === true,
        uploadAttempts: session.uploadAttempts || 0, nextUploadRetryAt: session.nextUploadRetryAt || null,
        cancelRequested: session.cancelRequested === true, cancellationConfirmed: session.cancellationConfirmed === true
      } : null,
      result: publicResult,
      ...(includeLive ? { live: session ? buildLiveActivity(session) : sanitizeLiveActivity(result?.live) } : {})
    };
  };
  const trustedControl = (sender) => trustedExtensionControl(api, sender);
  const validPage = (session, sender) => !!session && sender?.id === api.runtime.id &&
    sender.tab?.id === session.tabId && sender.frameId === 0 && origin(sender.url) === session.origin;

  function cancelLiveAnalysis(sessionId) {
    if (!liveRequest || (sessionId && sessionId !== liveRequest.sessionId)) return false;
    liveRequest.controller.abort();
    return true;
  }

  async function analyzeLive(message) {
    requirePower();
    if (message.consent !== true || typeof message.sessionId !== "string") throw new Error("Enable live local AI for this active capture first.");
    if (liveRequest) throw new Error("A live interpretation is already running.");
    const flight = { controller: new AbortController(), sessionId: message.sessionId };
    const token = authorityEpoch;
    liveRequest = flight;
    let timer;
    try {
      const session = await read(SESSION_KEY);
      const settings = await read(SETTINGS_KEY) || {};
      requirePower();
      if (flight.controller.signal.aborted || token !== authorityEpoch || settings.enabled !== true || session?.consent !== true ||
          session.status !== "recording" || session.powerPaused || session.sessionId !== message.sessionId) {
        throw new Error("Live interpretation requires the current consented, active capture.");
      }
      const live = buildLiveActivity(session);
      if (!live?.recentEvents?.length) throw new Error("Waiting for captured actions before local interpretation.");
      const startedAt = now();
      if ((lastLiveRequestAt && startedAt - lastLiveRequestAt < 15000) ||
          (lastLiveSession === session.sessionId && live.eventCount <= lastLiveRevision)) {
        throw new Error("Live local AI waits at least 15 seconds and for new captured actions.");
      }
      lastLiveRequestAt = startedAt;
      lastLiveSession = session.sessionId;
      lastLiveRevision = live.eventCount;
      timer = setTimeout(() => flight.controller.abort(), 18000);
      const response = await request(`${BACKEND_ORIGIN}/api/extension/live-insight`, {
        method: "POST", headers: HEADERS, signal: flight.controller.signal,
        body: JSON.stringify({ consent: true, sessionId: live.sessionId, revision: live.eventCount,
          goal: live.goal, page: live.page, events: live.recentEvents })
      });
      if (!response.ok) throw new Error(response.status === 429 ? "Local AI is busy or cooling down; observed activity continues." : "Local AI interpretation is unavailable. Observed activity continues; no remote fallback was used.");
      const body = await response.json();
      const current = await read(SESSION_KEY);
      const enabled = (await read(SETTINGS_KEY))?.enabled === true;
      requirePower();
      if (flight.controller.signal.aborted || token !== authorityEpoch || !enabled || current?.consent !== true || current?.sessionId !== session.sessionId ||
          current.status !== "recording" || current.powerPaused) throw new Error("Live interpretation was superseded; no result was retained.");
      const evidence = new Set(live.recentEvents.map(event => event.seq));
      if (body?.ok !== true || body.sessionId !== session.sessionId || body.revision !== live.eventCount ||
          body.source !== "local-ai" || body.execution_authorized !== false || !["low", "medium"].includes(body.confidence) ||
          !Number.isFinite(body.analyzedAt) || body.analyzedAt <= 0 ||
          !Array.isArray(body.evidence) || body.evidence.length > 12 || !body.evidence.length ||
          body.evidence.some(seq => !evidence.has(seq)) || new Set(body.evidence).size !== body.evidence.length ||
          [["model", 120], ["summary", 500], ["intent", 300], ["possibleIssue", 300]].some(([key, max]) => typeof body[key] !== "string" || body[key].length > max) ||
          !body.summary.trim()) throw new Error("Local AI returned an ungrounded interpretation; no result was retained.");
      return { ok: true, sessionId: body.sessionId, revision: body.revision, source: "local-ai", model: sanitizeText(body.model, 120),
        analyzedAt: body.analyzedAt, summary: sanitizeText(body.summary, 500), intent: sanitizeText(body.intent, 300),
        possibleIssue: sanitizeText(body.possibleIssue, 300), evidence: [...body.evidence], confidence: body.confidence, execution_authorized: false };
    } finally {
      clearTimeout(timer);
      if (liveRequest === flight) liveRequest = null;
    }
  }

  function automationFinished(result) {
    return !result.cancelRequested && !result.error && TERMINAL_AUTOMATION_STATES.has(result.automation?.status);
  }

  /**
   * Discover the delivery destinations the backend offers.
   *
   * A destination is only usable when the backend confirms it is configured
   * and reachable. The kind and the canonical target are both returned, and
   * the target is frozen for the session once consent is given.
   */
  async function automationTargets() {
    const response = await request(`${BACKEND_ORIGIN}/api/extension/integrations`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Destination discovery returned HTTP ${response.status}.`);
    const body = await response.json();
    if (!Array.isArray(body?.destinations)) throw new Error("The backend did not return a destination list.");
    return body.destinations;
  }

  async function automationTarget(kind) {
    const response = await request(`${BACKEND_ORIGIN}/api/extension/integrations/${encodeURIComponent(kind)}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Destination configuration returned HTTP ${response.status}.`);
    const body = await response.json();
    if (!body.url) throw new Error("Configure a delivery destination before enabling automatic delivery.");
    // Reachability may be false while the configured canonical destination is known.
    const url = new URL(body.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname === "") {
      throw new Error("The configured destination is not a usable origin.");
    }
    return { ok: true, url: body.url, kind };
  }

  async function ensureAlarm() {
    if (!api.alarms) return;
    if (!powered()) { await api.alarms.clear(AUTOMATION_ALARM); return; }
    const session = await read(SESSION_KEY);
    const result = await read(RESULT_KEY);
    const needed = !!((!session?.powerPaused && (session?.nextUploadRetryAt || (session?.cancelRequested && (session.cancelAttempts || 0) < MAX_UPLOAD_ATTEMPTS && now() < session.startTime + CONSENT_TTL_MS))) ||
      (result?.automationPolicy && !result.powerPaused && !automationFinished(result) && !result.pollExpired));
    if (needed) {
      if (!await api.alarms.get(AUTOMATION_ALARM)) await api.alarms.create(AUTOMATION_ALARM, { periodInMinutes: 1 });
    } else await api.alarms.clear(AUTOMATION_ALARM);
  }

  function acceptAutomation(body, result) {
    if (body?.ok !== true || body.recording_id !== result.id || !AUTOMATION_STATES.has(body.status) ||
        body.target_url !== result.automationPolicy.target_url ||
        body.target_kind !== result.automationPolicy.target_kind ||
        body.use_ai !== result.automationPolicy.use_ai ||
        body.max_tickets !== result.automationPolicy.max_tickets ||
        body.execution_authorized !== false || body.expires_at !== result.consentExpiresAt / 1000 ||
        !Number.isInteger(body.ticket_count) || !Number.isInteger(body.delivered_count) ||
        body.ticket_count < 0 || body.ticket_count > 20 ||
        (body.ticket_count > 5 && !(body.status === "blocked" && body.delivered_count === 0 && body.deliveries?.length === 0)) ||
        body.delivered_count < 0 || body.delivered_count > 5 || body.delivered_count > body.ticket_count ||
        !Array.isArray(body.deliveries) || body.deliveries.length > 5 ||
        body.deliveries.filter((item) => item?.state === "delivered" && item.verified === true).length !== body.delivered_count) throw new Error("Backend returned an unverified delivery status; check the recording before retrying.");
    // The backend returns content-free delivery receipts. Retain links and partial
    // receipts even when a later status is blocked or cancelled.
    result.automation = body;
    result.ticketCount = body.ticket_count;
    result.automationCheckedAt = now();
    result.error = "";
    if (TERMINAL_AUTOMATION_STATES.has(body.status)) result.cancelRequested = false;
  }

  async function refreshAutomation(result, action = null) {
    requirePower();
    if (action) result.powerPaused = false;
    result.status = "automation";
    result.lastPollAt = now();
    if (action === "cancel") result.cancelRequested = true;
    await saveResult(result);
    try {
      const response = await request(`${BACKEND_ORIGIN}/api/extension/automation/${encodeURIComponent(result.id)}`, {
        ...(action ? { method: "POST", headers: HEADERS, body: JSON.stringify({ action }) } : {}), signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`Delivery status returned HTTP ${response.status}.`);
      acceptAutomation(await response.json(), result);
      if (result.cancelRequested && !TERMINAL_AUTOMATION_STATES.has(result.automation.status)) {
        result.error = "Cancellation is pending. Already delivered or in-flight tickets cannot be undone.";
      }
    } catch (error) {
      result.error = `${error.message} Delivery status is unknown; no new generation was requested.${result.cancelRequested ? " Cancellation is not yet confirmed; already delivered or in-flight tickets cannot be undone." : ""}`;
    }
    await saveResult(result);
    await ensureAlarm();
    return status();
  }

  async function savedResult(session, id, automation = null) {
    const automated = !!session.automation && !session.automationWithdrawn;
    const result = { id, status: automated ? "automation" : "generating", tabId: session.tabId, origin: session.origin,
      eventCount: session.events.length, screenshotCount: session.screenshots.length, ticketCount: 0, error: "", warning: session.warning || "",
      live: buildLiveActivity(session) };
    if (automated) {
      result.automationPolicy = structuredClone(session.automation);
      result.consentExpiresAt = session.startTime + CONSENT_TTL_MS;
      result.cancelRequested = session.cancelRequested === true;
      if (automation) acceptAutomation(automation, result);
    }
    await saveResult(result);
    await api.storage.local.remove(SESSION_KEY);
    try { await api.action.setBadgeText({ tabId: session.tabId, text: "" }); } catch {}
    await audit("saved", { tabId: session.tabId, eventCount: session.events.length });
    await ensureAlarm();
    return result;
  }

  async function cancelAutomation() {
    const session = await read(SESSION_KEY);
    if (session?.automation && !session.automationWithdrawn) {
      session.nextUploadRetryAt = null;
      if (!session.uploadAttempts) {
        session.automationWithdrawn = true;
        session.warning = `${session.warning ? `${session.warning} ` : ""}Automatic delivery withdrawn. Stop will save reviewable drafts only.`;
        await save(session);
        await audit("automatic_delivery_withdrawn");
        await ensureAlarm();
        return status();
      }
      // An upload with a lost response may already own a running backend job.
      // Never replay its identity with altered consent or claim local discard
      // cancels that job. Reconcile the precomputed stable recording identity.
      session.cancelRequested = true;
      session.lastCancelAt = now();
      session.cancelAttempts = (session.cancelAttempts || 0) + 1;
      await save(session);
      try {
        const response = await request(`${BACKEND_ORIGIN}/api/extension/automation/${session.recordingId}`, {
          method: "POST", headers: HEADERS, body: JSON.stringify({ action: "cancel" }), signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error(`Cancellation returned HTTP ${response.status}.`);
        const body = await response.json();
        if (body?.ok === true && body.recording_id === session.recordingId && body.status === "cancelled" && body.upload_cancelled === true && body.execution_authorized === false && body.delivered_count === 0) {
          session.automationWithdrawn = true;
          session.cancellationConfirmed = true;
          session.cancelRequested = false;
          session.error = "Automatic delivery was cancelled before the backend accepted this capture. Its local events remain here; discard this copy before starting a new capture. No retry will revive this cancelled identity.";
          await save(session);
          await ensureAlarm();
          return status();
        }
        const result = await savedResult(session, session.recordingId, body);
        if (!TERMINAL_AUTOMATION_STATES.has(result.automation.status)) result.error = "Cancellation is not yet confirmed; already delivered or in-flight tickets cannot be undone.";
        await saveResult(result);
      } catch (error) {
        session.error = `${error.message} Automatic upload retries are stopped. A previous upload may have been accepted; cancellation is unconfirmed. Check again before discarding.`;
        await save(session);
      }
      await ensureAlarm();
      return status();
    }
    const result = await read(RESULT_KEY);
    if (!result?.automationPolicy) throw new Error("There is no automatic delivery to cancel.");
    return refreshAutomation(result, "cancel");
  }

  async function reconcileUpload(session) {
    try {
      const response = await request(`${BACKEND_ORIGIN}/api/extension/automation/${session.recordingId}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Upload status returned HTTP ${response.status}.`);
      const body = await response.json();
      if (body?.ok === true && body.recording_id === session.recordingId && body.status === "cancelled" && body.upload_cancelled === true && body.execution_authorized === false && body.delivered_count === 0) {
        session.automationWithdrawn = true;
        session.cancellationConfirmed = true;
        session.cancelRequested = false;
        session.nextUploadRetryAt = null;
        session.error = "The backend confirmed this upload identity was cancelled. Its local events remain here; discard this copy before starting a new capture.";
        await save(session);
      } else {
        const result = await savedResult(session, session.recordingId, body);
        if (result.cancelRequested) {
          result.error = "The upload was accepted, but cancellation is not yet confirmed. Already delivered or in-flight tickets cannot be undone.";
          await saveResult(result);
        }
      }
    } catch (error) {
      session.error = `${error.message} Upload acceptance is still unknown. The local capture is retained; checking status never resends it.`;
      await save(session);
    }
    await ensureAlarm();
    return status();
  }

  async function automationTick() {
    if (!powered()) return;
    const session = await read(SESSION_KEY);
    if (session?.cancelRequested && !session.powerPaused) {
      if ((session.cancelAttempts || 0) < MAX_UPLOAD_ATTEMPTS && now() < session.startTime + CONSENT_TTL_MS && now() - session.lastCancelAt >= 60000) await cancelAutomation();
    } else if (!session?.powerPaused && session?.status === "pending" && session.nextUploadRetryAt && now() >= session.nextUploadRetryAt) {
      await upload(session, true);
    }
    const result = await read(RESULT_KEY);
    if (result?.automationPolicy && !result.powerPaused && !result.pollExpired && !automationFinished(result) && now() - (result.lastPollAt || 0) >= 5000) {
      if (now() >= result.consentExpiresAt) {
        result.pollExpired = true;
        result.error = "The 24-hour delivery consent window ended. Open review to check the backend's final status; no automatic upload or retry will run.";
        await saveResult(result);
      } else await refreshAutomation(result, result.cancelRequested ? "cancel" : null);
    }
    await ensureAlarm();
  }

  async function inject(session) {
    requirePower();
    // The page's own uncaught failures are only observable from the page's
    // world. Install that relay first so a failure during page setup is not
    // lost. A relay that cannot be installed only removes exception detail.
    try {
      await api.scripting.executeScript({
        target: { tabId: session.tabId, frameIds: [0] },
        world: "MAIN",
        func: pantherDiagnosticRelay,
        args: [session.diagnosticNonce]
      });
    } catch { /* Exception diagnostics stay unavailable; capture continues. */ }
    requirePower();
    await api.scripting.executeScript({ target: { tabId: session.tabId, frameIds: [0] }, files: ["content/content.js"] });
    requirePower();
    const reply = await tabMessage(session.tabId, { type: "extension.captureStart", sessionId: session.sessionId,
      automationEnabled: !!session.automation && !session.automationWithdrawn, diagnosticNonce: session.diagnosticNonce,
      captureStartMs: session.startTime });
    if (!reply?.ok) throw new Error("The page could not start capture. Reload the page and try again.");
  }

  async function start(message) {
    requirePower();
    if (/preview/i.test(api.runtime.getManifest?.().name || "")) throw new Error("This browser build is an unsupported preview. Use Chrome or Edge 116+ for capture.");
    const settings = await read(SETTINGS_KEY) || {};
    if (settings.enabled !== true || message.consent !== true) throw new Error("Enable capture consent before starting.");
    if (await read(SESSION_KEY)) throw new Error("Finish or discard the existing capture before starting another.");
    const previous = await read(RESULT_KEY);
    if (previous?.automationPolicy && !automationFinished(previous)) throw new Error("Finish or cancel the current delivery before starting another capture.");
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id !== message.tabId) throw new Error("Choose the currently active tab to capture.");
    if (!/^https?:\/\//i.test(tab.url || "")) throw new Error("Choose an ordinary http or https webpage. Browser settings and extension pages cannot be captured.");
    if (message.audio || message.video) throw new Error("Video and tab audio are not supported in this release.");
    let automation = null;
    if (message.automation?.enabled === true) {
      if (message.automation.consent !== true || typeof message.automation.use_ai !== "boolean" || message.automation.max_tickets !== 5) {
        throw new Error("Automatic delivery requires fresh consent, a model choice, and the five-ticket limit.");
      }
      const kind = typeof message.automation.target_kind === "string" ? message.automation.target_kind : "";
      if (!kind) throw new Error("Choose a delivery destination before enabling automatic delivery.");
      const target = await automationTarget(kind);
      if (message.automation.target_url !== target.url) throw new Error("The delivery destination changed or is unknown. Refresh the popup and consent to the displayed destination again.");
      automation = { enabled: true, consent: true, target_kind: kind, target_url: target.url, use_ai: message.automation.use_ai, max_tickets: 5 };
    }
    const session = {
      sessionId: crypto.randomUUID(), status: "recording", consent: true,
      tabId: tab.id, windowId: tab.windowId, origin: origin(tab.url),
      startTime: now(), url: sanitizeUrl(tab.url), title: sanitizeText(tab.title || "", 200),
      goal: sanitizeText(message.goal || "", 1000), extensionId: api.runtime.id,
      screenshotConsent: message.screenshots === true, events: [], screenshots: [], lastScreenshotTs: 0, warning: "",
      automation, uploadAttempts: 0, nextUploadRetryAt: null, automationWithdrawn: false,
      diagnosticNonce: crypto.randomUUID()
    };
    if (automation) session.recordingId = await recordingId(session.extensionId, session.sessionId);
    requirePower();
    await save(session);
    try { await inject(session); }
    catch (error) { await api.storage.local.remove(SESSION_KEY); throw error; }
    await api.storage.local.remove(RESULT_KEY);
    await badge(session);
    await audit("start", { tabId: session.tabId, screenshots: session.screenshotConsent, automaticDelivery: !!automation, localAI: automation?.use_ai === true });
    return status();
  }

  async function screenshot(session, ts) {
    requirePower();
    if (!session.screenshotConsent || session.screenshots.length >= MAX_SCREENSHOTS || ts - session.lastScreenshotTs < SCREENSHOT_COOLDOWN_MS) return;
    const [before] = await api.tabs.query({ active: true, windowId: session.windowId });
    requirePower();
    if (before?.id !== session.tabId || origin(before.url) !== session.origin) return;
    // captureVisibleTab takes a WINDOW id, never a tab id.
    const dataUrl = await api.tabs.captureVisibleTab(session.windowId, { format: "jpeg", quality: 50 });
    requirePower();
    const [after] = await api.tabs.query({ active: true, windowId: session.windowId });
    requirePower();
    if (after?.id !== session.tabId || origin(after.url) !== session.origin) return;
    if (typeof dataUrl !== "string" || dataUrl.length > MAX_SCREENSHOT_BYTES) {
      session.warning = "A screenshot was unavailable or exceeded the image size limit. Your interaction events are still captured.";
      return;
    }
    session.screenshots.push({ ts, dataUrl });
    session.lastScreenshotTs = ts;
  }

  /**
   * Record an interaction, or a page failure the page itself disclosed.
   *
   * Both join the same ordered timeline, so a reviewer can see what happened
   * and what failed, in order. A failure is an observation, not a verified
   * defect, and it never leaves the local capture on its own. Both are
   * refused unless the capture is recording, consent is current, and the
   * sender is the captured top frame of the captured origin.
   */
  async function recordEvent(message, sender) {
    if (!powered()) return { ok: false, ignored: true };
    const session = await read(SESSION_KEY);
    const settings = await read(SETTINGS_KEY) || {};
    if (session?.status !== "recording" || settings.enabled !== true ||
        message.sessionId !== session.sessionId || !validPage(session, sender)) return { ok: false, ignored: true };
    const event = sanitizeCaptureEvent(message.payload, now());
    if (!event) return { ok: false, ignored: true };
    if (!powered()) return { ok: false, ignored: true };
    session.events.push(event);
    await save(session);
    if (event.type === "click" || event.type === "submit") {
      const previousCount = session.screenshots.length;
      const previousWarning = session.warning;
      try { await screenshot(session, event.ts); }
      catch {
        session.warning = "Screenshots unavailable. Start a new capture from Panther's toolbar icon to grant screenshot access. Your interaction events are still captured.";
      }
      if (session.screenshots.length !== previousCount || session.warning !== previousWarning) await save(session);
    }
    if (session.events.length >= MAX_EVENTS) return stop("event_limit");
    return { ok: true, eventCount: session.events.length, warning: session.warning || "" };
  }

  async function generate(result) {
    requirePower();
    if (result.automationPolicy) throw new Error("Automatic delivery owns draft generation for this recording. Check its existing job instead.");
    result.status = "generating";
    result.error = "";
    await saveResult(result);
    try {
      const response = await request(`${BACKEND_ORIGIN}/api/extension/tickets/${encodeURIComponent(result.id)}`, {
        method: "POST", headers: HEADERS, body: JSON.stringify({ use_ai: false }), signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error(`Draft generation returned HTTP ${response.status}.`);
      const body = await response.json();
      if (!Array.isArray(body.tickets)) throw new Error("Backend returned no draft ticket list.");
      result.status = "ready";
      result.ticketCount = body.tickets.length;
      await audit("drafts_ready", { ticketCount: result.ticketCount });
    } catch (error) {
      result.status = "error";
      result.error = `${error.message} Your recording is saved; retry draft generation.`;
    }
    await saveResult(result);
    return status();
  }

  async function upload(session, automaticRetry = false) {
    requirePower();
    const automated = !!session.automation && !session.automationWithdrawn;
    if (session.cancelRequested) throw new Error("Cancellation is unconfirmed. Check cancellation before attempting another upload.");
    if (session.cancellationConfirmed) throw new Error("This upload identity was cancelled. Discard the local copy before starting a new capture.");
    if (automated && (now() >= session.startTime + CONSENT_TTL_MS || (session.uploadAttempts || 0) >= MAX_UPLOAD_ATTEMPTS)) {
      session.status = "pending";
      session.nextUploadRetryAt = null;
      session.error = "Automatic delivery upload stopped: its 24-hour consent window or three-retry limit was reached. Check cancellation or review the saved job; consent is not renewed by retry.";
      await save(session);
      await ensureAlarm();
      return { ...(await status()), ok: false, error: session.error };
    }
    if (automaticRetry && (!automated || !session.uploadAttempts)) return status();
    session.powerPaused = false;
    session.status = "saving";
    session.error = "";
    session.nextUploadRetryAt = null;
    session.uploadAttempts = (session.uploadAttempts || 0) + 1;
    await save(session);
    await badge(session);
    const payload = {
      sessionId: session.sessionId, events: session.events, screenshots: session.screenshots,
      tabId: session.tabId, startTime: session.startTime, endTime: session.endTime,
      extensionId: session.extensionId, url: session.url, title: session.title, goal: session.goal,
      consent: session.consent, screenshotsConsent: session.screenshotConsent, stopReason: session.stopReason
    };
    if (automated) payload.automation = session.automation;
    let receipt;
    try {
      const response = await request(`${BACKEND_ORIGIN}/api/extension/record`, {
        method: "POST", headers: HEADERS, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}.`);
      receipt = await response.json();
      requirePower();
      if (!receipt.id) throw new Error("Backend did not return a recording receipt.");
      if (automated && receipt.id !== session.recordingId) throw new Error("Backend returned a mismatched recording identity.");
    } catch (error) {
      session.status = "pending";
      session.error = `${error.message} Capture is saved in this browser; retry when the backend is available.`;
      if (powered() && automated && session.uploadAttempts < MAX_UPLOAD_ATTEMPTS && now() < session.startTime + CONSENT_TTL_MS) {
        session.nextUploadRetryAt = now() + 60000 * 2 ** (session.uploadAttempts - 1);
        session.error += " Automatic upload retry is scheduled; the destination and consent are unchanged.";
      }
      await save(session);
      await badge(session);
      await ensureAlarm();
      return { ...(await status()), ok: false, error: session.error };
    }
    // Save the receipt before dropping the upload copy. Retries use sessionId
    // idempotency if termination occurs between either durable write.
    const result = await savedResult(session, receipt.id);
    // Only the backend job generates and delivers for an automated session.
    return automated ? refreshAutomation(result) : generate(result);
  }

  async function stop(reason = "user") {
    cancelLiveAnalysis();
    const session = await read(SESSION_KEY);
    if (!session) return status();
    if (session.status === "recording") {
      session.status = "pending";
      session.endTime = now();
      session.stopReason = reason;
      await save(session);
      await tabMessage(session.tabId, { type: "extension.captureStop", sessionId: session.sessionId });
      await audit("stop", { tabId: session.tabId, reason });
    }
    if (session.automation && !session.automationWithdrawn && reason !== "user") {
      session.error = "Capture stopped automatically. Use Stop & deliver / Retry upload to explicitly send it, or withdraw automatic delivery.";
      session.nextUploadRetryAt = null;
      await save(session);
      await badge(session);
      return status();
    }
    return upload(session);
  }

  async function openReview() {
    const result = await read(RESULT_KEY);
    await api.tabs.create({ url: api.runtime.getURL(`options/options.html${result?.id ? `?recording=${encodeURIComponent(result.id)}` : ""}`) });
    return { ok: true };
  }

  async function quiesceLocal(reason) {
    const settings = await read(SETTINGS_KEY) || {};
    await api.storage.local.set({ [SETTINGS_KEY]: { ...settings, enabled: false } });
    const session = await read(SESSION_KEY);
    if (session) {
      if (["recording", "saving"].includes(session.status)) {
        session.status = "pending";
        session.endTime ||= now();
        session.stopReason = "power_off";
      }
      session.powerPaused = true;
      session.nextUploadRetryAt = null;
      session.error = reason;
      await save(session);
      await tabMessage(session.tabId, { type: "extension.captureStop", sessionId: session.sessionId });
      await badge(session);
    }
    const result = await read(RESULT_KEY);
    if (result) {
      result.powerPaused = true;
      if (result.status === "generating") { result.status = "error"; result.error = reason; }
      if (result.automationPolicy && !automationFinished(result)) result.error = reason;
      await saveResult(result);
    }
    if (api.alarms) await api.alarms.clear(AUTOMATION_ALARM);
    return status();
  }

  async function handle(message, sender) {
    if (message.type === "page.interaction" || message.type === "page.diagnostic") return recordEvent(message, sender);
    if (message.type.startsWith("page.")) {
      const session = await read(SESSION_KEY);
      const result = await read(RESULT_KEY);
      if (!validPage(session || result, sender)) return { ok: false, ignored: true };
      if (message.type === "page.getStatus") return status();
      if (!powered()) return { ok: false, ignored: true };
      if (message.type === "page.stop" && message.sessionId === session?.sessionId) return stop();
      if (message.type === "page.openReview") return openReview();
      return { ok: false, ignored: true };
    }
    if (!trustedControl(sender)) return { ok: false, error: "Capture controls are only available in the extension." };
    if (["extension.analyzeLive", "extension.cancelLiveAnalysis"].includes(message.type) && !trustedMonitorControl(api, sender)) {
      return { ok: false, error: "Live interpretation controls are only available in the status window." };
    }
    if (trustedMonitorControl(api, sender) && !MONITOR_COMMANDS.has(message.type)) {
      return { ok: false, error: "Choose capture consent, a tab, and any retry in the toolbar popup. The status window cannot start or resume capture or delivery." };
    }
    if (trustedMonitorControl(api, sender) && message.type === "extension.stopRecording" && (await read(SESSION_KEY))?.status !== "recording") {
      return { ok: false, error: "There is no active capture to stop. Use the toolbar popup for an explicit upload retry." };
    }
    if (!["extension.getStatus", "extension.openReview", "extension.cancelLiveAnalysis"].includes(message.type) && !(message.type === "extension.setEnabled" && message.enabled !== true)) requirePower();
    switch (message.type) {
      case "extension.getStatus": return status(trustedMonitorControl(api, sender));
      case "extension.analyzeLive": return analyzeLive(message);
      case "extension.cancelLiveAnalysis": return { ok: true, cancelled: typeof message.sessionId === "string" && !!message.sessionId && cancelLiveAnalysis(message.sessionId) };
      case "extension.getAutomationTarget": return { ok: true, destinations: await automationTargets() };
      case "extension.startRecording": return start(message);
      case "extension.stopRecording": return stop();
      case "extension.openReview": return openReview();
      case "extension.refreshAutomation": {
        const session = await read(SESSION_KEY);
        if (session?.automation && session.uploadAttempts && !session.automationWithdrawn) return reconcileUpload(session);
        const result = await read(RESULT_KEY);
        if (!result?.automationPolicy) throw new Error("There is no saved automatic delivery to check.");
        return refreshAutomation(result);
      }
      case "extension.retryAutomation": {
        if ((await read(SETTINGS_KEY))?.enabled !== true) throw new Error("Select fresh capture consent before retrying delivery after Turn On.");
        const result = await read(RESULT_KEY);
        if (!result?.automationPolicy || result.automation?.status !== "retry_wait" || result.cancelRequested) throw new Error("Only a retry-wait delivery can be retried; blocked or cancelled jobs cannot be restarted here.");
        if (now() >= result.consentExpiresAt) throw new Error("The original delivery consent expired; retry cannot renew it.");
        return refreshAutomation(result, "retry");
      }
      case "extension.cancelAutomation": return cancelAutomation();
      case "extension.retryGeneration": {
        if ((await read(SETTINGS_KEY))?.enabled !== true) throw new Error("Select fresh capture consent before retrying generation after Turn On.");
        const result = await read(RESULT_KEY);
        if (!result) throw new Error("There is no saved recording to generate drafts from.");
        return generate(result);
      }
      case "extension.retryUpload": {
        if ((await read(SETTINGS_KEY))?.enabled !== true) throw new Error("Select fresh capture consent before retrying an upload after Turn On.");
        const session = await read(SESSION_KEY);
        if (!session || session.status === "recording") throw new Error("There is no stopped capture to retry.");
        return upload(session);
      }
      case "extension.discardCapture": {
        const session = await read(SESSION_KEY);
        requirePower();
        if (session?.status === "recording") throw new Error("Stop capture before discarding it.");
        if (session?.automation && session.uploadAttempts && !session.automationWithdrawn) throw new Error("An automatic upload may have been accepted. Confirm cancellation before discarding its local copy.");
        await api.storage.local.remove(SESSION_KEY);
        if (session) {
          try { await api.action.setBadgeText({ tabId: session.tabId, text: "" }); } catch {}
          await audit("discard", { tabId: session.tabId });
        }
        return status();
      }
      case "extension.setEnabled": {
        if (message.enabled !== true) cancelLiveAnalysis();
        const settings = await read(SETTINGS_KEY) || {};
        await api.storage.local.set({ [SETTINGS_KEY]: { ...settings, enabled: message.enabled === true } });
        await audit(message.enabled === true ? "consent_enabled" : "consent_disabled");
        if (message.enabled !== true) {
          const session = await read(SESSION_KEY);
          const result = await read(RESULT_KEY);
          if (powered() && ((session?.automation && !session.automationWithdrawn) || (result?.automationPolicy && !automationFinished(result)))) await cancelAutomation();
          if (powered() && (await read(SESSION_KEY))?.status === "recording") return stop("consent_revoked");
        }
        return status();
      }
      default: return { ok: false, error: "Unknown capture command." };
    }
  }

  // Worker recreation means an interrupted fetch has no owner. Keep a retryable
  // state; never claim a saved recording or completed generation without receipt.
  const recovery = (async () => {
    const session = await read(SESSION_KEY);
    // storage.session survives worker suspension but is cleared on browser or
    // extension restart. Check it before tab events can resume a restored page.
    if (api.storage.session) {
      const browserActive = (await api.storage.session.get(BROWSER_KEY))[BROWSER_KEY] === true;
      if (!browserActive && session?.status === "recording") {
        session.status = "pending";
        session.endTime = session.events.at(-1)?.ts || session.startTime;
        session.stopReason = "browser_or_extension_restarted";
        session.error = "Browser or extension restarted. Your captured events are saved; retry to upload them.";
        await save(session);
      }
      await api.storage.session.set({ [BROWSER_KEY]: true });
    }
    if (session?.status === "saving") {
      session.status = "pending";
      session.error = "Upload was interrupted. Retry to confirm the saved recording.";
      if (session.automation && !session.automationWithdrawn && !session.cancelRequested && session.uploadAttempts < MAX_UPLOAD_ATTEMPTS) {
        session.nextUploadRetryAt = now() + 60000;
      }
      await save(session);
    }
    const result = await read(RESULT_KEY);
    if (result?.status === "generating") {
      result.status = "error";
      result.error = "Draft generation was interrupted. Retry generation; your recording is saved.";
      await saveResult(result);
    }
    if (!powered()) await quiesceLocal("Panther is Off. Captured events are retained; turn On and select fresh consent before an explicit retry.");
    else await ensureAlarm();
  })();
  queue = recovery.catch(() => {});

  return {
    freeze: (reason = "Panther is Off. Captured events are retained.") => {
      frozen = true;
      authorityEpoch++;
      cancelLiveAnalysis();
      for (const controller of requests) controller.abort();
      return serial(() => quiesceLocal(reason));
    },
    // Only the lifecycle controller calls this after a successful native Start.
    // Pending sessions/results stay powerPaused; nothing is resumed here.
    unlock: () => { frozen = false; },
    message: (message, sender) => {
      // Optional inference never occupies the event/save/Stop queue. Status and
      // Off continue to work while a local model is slow or unavailable.
      if (["extension.analyzeLive", "extension.cancelLiveAnalysis"].includes(message.type)) return recovery.then(() => handle(message, sender));
      // Status polls must remain responsive while upload/generation is running.
      if (message.type === "extension.getStatus" || message.type === "page.getStatus") return recovery.then(async () => {
        const response = await handle(message, sender);
        // UI polling can improve freshness, but never owns job lifetime. Alarms
        // are the durable wakeup path when the popup and page panel are closed.
        if (response.ok && powered() && !pollQueued) {
          pollQueued = true;
          serial(automationTick).catch(() => {}).finally(() => { pollQueued = false; });
        }
        return response;
      });
      return serial(() => handle(message, sender));
    },
    tabUpdated: (tabId, change, tab) => serial(async () => {
      if (!powered()) return;
      const session = await read(SESSION_KEY);
      if (session?.status !== "recording" || session.tabId !== tabId) return;
      const url = change.url || tab.url;
      if (url && origin(url) !== session.origin) return stop("left_origin");
      if (change.status === "complete") {
        try { await inject(session); } catch { return stop("page_unavailable"); }
      }
    }),
    tabRemoved: (tabId) => serial(async () => {
      if (!powered()) return;
      const session = await read(SESSION_KEY);
      if (session?.status === "recording" && session.tabId === tabId) return stop("tab_closed");
    }),
    browserStarted: (reason = "browser_restarted") => serial(async () => {
      const session = await read(SESSION_KEY);
      if (session?.status === "recording") {
        session.status = "pending";
        session.endTime = session.events.at(-1)?.ts || session.startTime;
        session.stopReason = reason;
        session.error = "Browser or extension restarted. Your captured events are saved; retry to upload them.";
        await save(session);
      }
      await ensureAlarm();
    }),
    alarm: (name) => name === AUTOMATION_ALARM ? serial(automationTick) : Promise.resolve()
  };
}

function origin(url) {
  try { return new URL(url).origin; } catch { return ""; }
}

async function recordingId(extensionId, sessionId) {
  const bytes = new TextEncoder().encode(JSON.stringify([extensionId, sessionId]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
