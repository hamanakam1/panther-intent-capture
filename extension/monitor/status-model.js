// Pure presentation model. A saved receipt or cached capture is never a heartbeat.
export const STALE_AFTER_MS = 8000;
const POWER_STATES = new Set(["off", "on", "starting", "stopping", "error"]);
const TERMINAL_JOBS = new Set(["delivered", "blocked", "cancelled"]);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = value => typeof value === "string" ? value.slice(0, 600) : "";
const time = value => Number.isFinite(value) && value > 0 ? value : null;

export function monitorView(snapshot = {}, context = {}) {
  const checkedAt = time(context.checkedAt);
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const fresh = context.connected === true && checkedAt !== null && now - checkedAt <= STALE_AFTER_MS;
  const power = context.pendingPower || (fresh && POWER_STATES.has(snapshot.power?.state) ? snapshot.power.state : "unknown");
  const on = power === "on";
  const session = snapshot.session || null;
  const result = snapshot.result || null;
  // A new capture owns the current activity, even when an old result is retained.
  const job = !session && result?.automationPolicy ? result.automation : null;
  const paused = session?.powerPaused === true || (!session && result?.powerPaused === true);
  const retained = !!session || !!result;
  const source = session || result || {};
  const sourceError = text(session?.error || (!session && (result?.error || job?.error)));
  let activity = "Idle", detail = "Choose a webpage, then use Panther’s toolbar popup to consent and start capture.";
  let tone = "quiet";

  if (power === "unknown" || power === "error") {
    activity = "Unknown";
    detail = "Current activity cannot be confirmed. Saved counts below are not live progress.";
    tone = "warning";
  } else if (!on) {
    detail = power === "off" ? "The browser-controlled backend is off. Nothing starts automatically." :
      power === "starting" ? "Starting the backend only. Capture does not start automatically." :
      "Stopping capture and remaining automatic delivery. An already submitted request may finish.";
  } else if (paused) {
    detail = "Previous work is retained, not running. Use the toolbar popup to review it; nothing resumes automatically.";
  } else if (session?.cancellationConfirmed) {
    activity = "Cancelled"; detail = "Automatic delivery was cancelled. Captured evidence is retained.";
  } else if (sourceError || session?.cancelRequested || (!session && result?.cancelRequested)) {
    activity = "Blocked"; tone = "warning";
    detail = session?.cancelRequested || (!session && result?.cancelRequested) ? "Cancellation is not yet confirmed. Existing or in-flight tickets cannot be undone." : "This session needs attention. Use the toolbar popup to inspect or recover it.";
  } else if (session) {
    if (snapshot.status === "recording") {
      activity = "Capturing"; tone = "active";
      detail = "Capturing interactions in your chosen tab.";
    } else if (snapshot.status === "saving") {
      activity = "Saving"; tone = "active"; detail = "Saving captured evidence to the local backend.";
    } else {
      activity = "Blocked"; tone = "warning"; detail = "Capture is retained in this browser. Open the toolbar popup to inspect the pending upload.";
    }
  } else if (result?.automationPolicy) {
    const states = {
      queued: ["Generating", "Ticket generation is queued.", "active"],
      generating: ["Generating", "Preparing reviewable tickets from the saved capture.", "active"],
      delivering: ["Delivering", "Sending opted-in tickets and checking delivery receipts.", "active"],
      retry_wait: ["Blocked", "Delivery is waiting for a retry. No successful delivery is implied.", "warning"],
      delivered: ["Ready", "Ticket delivery completed at the recorded check time. Panther does not implement the work.", "ready"],
      blocked: ["Blocked", "Automatic delivery is blocked. Review the saved result before taking another action.", "warning"],
      cancelled: ["Cancelled", "Remaining automatic delivery was cancelled. Existing tickets are unchanged.", "quiet"]
    };
    [activity, detail, tone] = states[job?.status] || ["Unknown", "No confirmed delivery status is available.", "warning"];
  } else if (snapshot.status === "generating") {
    activity = "Generating"; tone = "active"; detail = "Generating reviewable drafts from the saved capture.";
  } else if (snapshot.status === "ready" && result) {
    activity = "Ready"; tone = "ready"; detail = "Drafts are ready to review. They have not been sent to another system.";
  } else if (snapshot.status === "error") {
    activity = "Blocked"; tone = "warning"; detail = "The saved result needs attention. Use the toolbar popup to inspect it.";
  }

  const sessionAutomatic = !!session?.automation && !session.automationWithdrawn;
  const resultAutomatic = !session && !!result?.automationPolicy;
  const cancellationPending = session?.cancelRequested || (!session && result?.cancelRequested);
  const cancellable = sessionAutomatic || (resultAutomatic && (!TERMINAL_JOBS.has(job?.status) || !!result.error || cancellationPending));
  const title = {off: "Panther is off", on: "Panther is on", starting: "Turning on…", stopping: "Turning off…", error: "Runtime needs attention", unknown: "Status unknown"}[power];

  return {
    power, title, on, fresh, checkedAt, activity, detail, tone,
    runtimeHelp: on ? "Backend process confirmed; not a backend or destination health check." :
      power === "off" ? "No capture or automatic delivery starts while Panther is off." :
      power === "unknown" ? "Connection to the extension is unconfirmed. Do not treat the last known On state as live." :
      power === "error" ? "The runtime could not confirm its state. Turn off remains available." :
      "Power controls stay separate from capture and ticket work.",
    historical: !on || paused,
    countsHeading: !on || paused ? "Retained information" : session ? "Current capture" : result ? "Saved result" : "This session",
    events: count(source.eventCount), screenshots: count(source.screenshotCount),
    drafts: count(result?.automationPolicy ? result?.automation?.ticket_count : result?.ticketCount),
    delivered: count(result?.automation?.delivered_count), ticketTotal: count(result?.automation?.ticket_count),
    hasResult: !!result, hasReceipts: !!result?.automationPolicy,
    resultHistorical: !!session || !on || paused,
    stage: text(result?.automation?.stage), receiptCheckedAt: time(result?.automationCheckedAt),
    error: text(context.connectionError || snapshot.power?.error || context.operationError || sourceError),
    warning: text(session?.warning || (!session && result?.warning)),
    showOn: ["off", "error", "unknown"].includes(power),
    offDisabled: power === "off" || power === "stopping",
    canStop: on && !paused && snapshot.status === "recording" && !!session,
    stopLabel: sessionAutomatic ? "Stop & deliver tickets" : "Stop & generate drafts",
    canCancel: on && !paused && cancellable,
    cancelLabel: cancellationPending ? "Check cancellation" : "Cancel remaining delivery",
    canReview: on && !!result?.id,
    retained
  };
}

// Only the background's bounded, sanitized projection is rendered here. Raw
// session events, typed values and screenshot pixels never enter this view.
export function liveView(snapshot = {}, state = {}, now = Date.now()) {
  const live = snapshot.live;
  const hasData = !!live && typeof live.sessionId === "string" && !!live.sessionId;
  const current = hasData && state.canStop === true && snapshot.enabled === true && live.sessionId === snapshot.session?.sessionId;
  const events = hasData ? count(live.eventCount) : 0;
  const observedAt = hasData ? time(live.observedAt) : null;
  const age = observedAt ? Math.max(0, Math.floor((now - observedAt) / 1000)) : null;
  const evidence = values => Array.isArray(values) ? values.filter(value => Number.isSafeInteger(value) && value > 0 && value <= events).slice(0, 12) : [];
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const recentEvents = hasData && Array.isArray(live.recentEvents) ? live.recentEvents.slice(-12).filter(record).map(event => ({seq: count(event.seq), ts: time(event.ts), label: text(event.label).slice(0, 240) || text(event.type).slice(0, 60) || "Page interaction"})).filter(event => event.seq > 0 && event.seq <= events) : [];
  const patterns = hasData && Array.isArray(live.patterns) ? live.patterns.slice(0, 5).filter(record).map(pattern => ({title: text(pattern.title).slice(0, 120), detail: text(pattern.detail).slice(0, 300), evidence: evidence(pattern.evidence)})).filter(pattern => pattern.title && pattern.evidence.length) : [];
  const inferred = hasData ? text(live.inferredIntent) : "";
  return {
    hasData, current, sessionId: hasData ? live.sessionId : "", events, observedAt, recentEvents, patterns,
    summary: hasData ? text(live.summary) || "Waiting for captured interactions to describe this session." : "Panther is not capturing. Choose a webpage and start a consented capture from the toolbar.",
    goal: hasData ? text(live.goal) : "", intent: /^User-stated goal:/i.test(inferred) ? "" : inferred.replace(/^Tentative interpretation from recent controls:\s*/i, ""),
    page: hasData ? text(live.page?.url).slice(0, 220) : "",
    pageTitle: hasData ? text(live.page?.title).slice(0, 160) : "",
    mode: current ? "Live · rules" : hasData ? "Historical · rules" : "Not capturing",
    freshness: observedAt ? `${current ? "Last observed event" : "Historical last event"}: ${age}s ago. ${current ? "No new events means no new observed activity." : "This is retained evidence, not current activity."}` : current ? "Capture is active; no observed events yet." : "No captured activity yet.",
    coverage: recentEvents.length ? `Showing ${recentEvents.length} recent events of ${events}. Evidence numbers refer to this capture.` : ""
  };
}


// A bounded navigation hint, never an instruction to execute a proposal.
export function nextStepView(state = {}) {
  if (!state.fresh || state.power === "unknown" || state.power === "error") return {stage: "", title: "Confirm Panther’s connection", detail: "The last known state may be out of date. Check the runtime message below; Off remains available."};
  if (state.power === "starting" || state.power === "stopping") return {stage: "", title: "Wait for the power change", detail: "Capture and delivery resume only after an explicit action and a confirmed state."};
  if (!state.on) return {stage: "capture", title: "Start with one clear intention", detail: "Turn Panther on, open your chosen webpage, then use the toolbar popup to describe the outcome you want and consent to capture."};
  if (state.historical) return {stage: "review", title: "Pick up the retained capture", detail: "Previous work is saved, not running. Open the toolbar popup to review or recover it before starting again."};
  if (state.activity === "Capturing") return {stage: "capture", title: "Show the workflow you want to improve", detail: "Use your chosen tab. When the useful evidence is captured, Stop saves it and prepares reviewable drafts."};
  if (["Saving", "Generating", "Delivering"].includes(state.activity)) return {stage: "review", title: "Your capture is being processed", detail: "Watch the confirmed status below. Keep Off available while saving, drafting or opted-in delivery finishes."};
  if (["Blocked", "Cancelled"].includes(state.activity)) return {stage: "review", title: "Resolve the saved session", detail: "Your evidence is retained. Review the message below and use the toolbar popup for retry or recovery controls."};
  if (state.hasResult) return {stage: "handoff", title: "Review what happened and what should change", detail: "Open the saved result, check its observed evidence, edit the expected outcome, then export for Companion or preview ticket delivery."};
  return {stage: "capture", title: "Choose a page and state your goal", detail: "Open Panther from that page’s toolbar. Consent and Start capture there; turning Panther on alone never records."};
}
