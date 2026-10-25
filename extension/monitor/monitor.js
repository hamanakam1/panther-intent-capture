import { monitorView, liveView, nextStepView } from "./status-model.js";

const elements = Object.fromEntries(["nextTitle", "nextDetail", "stepCapture", "stepReview", "stepHandoff", "powerStatus", "powerDot", "turnOnBtn", "turnOffBtn", "runtimeHelp", "activity", "activityDetail", "operationStatus", "connectionStatus", "error", "warning", "countsHeading", "eventCount", "screenshotCount", "historyNote", "resultSummary", "draftSummary", "receiptSummary", "receiptTime", "stopBtn", "cancelBtn", "reviewBtn", "understandingMode", "understandingSummary", "observationFreshness", "intentContext", "observedPage", "statedGoal", "inferredIntent", "frictionSection", "frictionList", "recentEmpty", "recentActions", "eventCoverage", "liveAiToggle", "liveAiStatus", "liveAiResult", "liveAiProvenance", "liveAiSummary", "liveAiIntent", "liveAiIssue", "liveAiEvidence"].map(id => [id, document.getElementById(id)]));
const POLL_MS = 500;
const STATUS_TIMEOUT_MS = 6000;
let snapshot = {};
let checkedAt = null;
let connected = false;
let connectionError = "";
let operationError = "";
let pendingPower = null;
let operationPending = "";
let epoch = 0;
let operationEpoch = 0;
let polling = false;
let closed = false;
let aiEnabled = false;
let aiOptInEpoch = 0;
let aiSessionId = "";
let aiInFlight = false;
let aiPending = false;
let aiLastAttemptAt = null;
let aiLastAttemptRevision = -1;
let aiResult = null;
let aiError = "";
const AI_INTERVAL_MS = 15000;

const clockText = timestamp => new Date(timestamp).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
const view = () => monitorView(snapshot, {checkedAt, now: Date.now(), connected, pendingPower, connectionError, operationError});
const visible = () => document.visibilityState !== "hidden";

function disableAI({clear = false} = {}) {
  const wasEnabled = aiEnabled;
  aiEnabled = false;
  ++aiOptInEpoch;
  aiPending = false;
  aiError = "";
  if (clear) aiResult = null;
  if (wasEnabled && aiSessionId) {
    // Cancellation is best effort: an already-running local model may finish,
    // but its late answer cannot enter this window and no next request starts.
    const cancelledSessionId = aiSessionId;
    Promise.resolve().then(() => chrome.runtime.sendMessage({type: "extension.cancelLiveAnalysis", sessionId: cancelledSessionId})).catch(() => {});
  }
}

function renderUnderstanding(state) {
  const live = liveView(snapshot, state, Date.now());
  if (live.sessionId !== aiSessionId) {
    disableAI({clear: true});
    aiSessionId = live.sessionId;
    aiLastAttemptRevision = -1;
  }
  if (aiEnabled && (!live.current || !visible() || operationPending)) disableAI();
  elements.understandingMode.textContent = live.mode;
  elements.understandingSummary.textContent = live.summary;
  elements.observationFreshness.textContent = live.freshness;
  elements.observationFreshness.dataset.stale = String(!live.current);
  elements.intentContext.hidden = !live.hasData;
  elements.observedPage.textContent = [live.page ? `Latest observed route: ${live.page}` : "", live.pageTitle ? `Capture-start title: ${live.pageTitle}` : ""].filter(Boolean).join(" · ");
  elements.observedPage.hidden = !live.page && !live.pageTitle;
  elements.statedGoal.textContent = live.goal ? `Your stated goal: ${live.goal}` : "No goal was provided for this capture.";
  elements.inferredIntent.textContent = live.intent ? `Tentative interpretation · rules: ${live.intent}` : "Not enough observed activity to infer an intent yet.";
  elements.inferredIntent.hidden = !live.hasData;
  elements.frictionSection.hidden = !live.patterns.length;
  elements.frictionList.replaceChildren(...live.patterns.map(pattern => {
    const row = document.createElement("li");
    row.textContent = `${pattern.title}: ${pattern.detail} Evidence ${pattern.evidence.map(seq => `#${seq}`).join(", ")}. Hypothesis, not a confirmed defect.`;
    return row;
  }));
  elements.recentEmpty.hidden = live.recentEvents.length > 0;
  elements.recentEmpty.textContent = live.current ? "Capture is active. Interact with the chosen page to see observed activity here." : live.hasData ? "No recorded actions are available in this retained summary." : "Nothing captured yet. Turning Panther on does not start recording.";
  elements.recentActions.replaceChildren(...live.recentEvents.slice().reverse().map(event => {
    const row = document.createElement("li"), meta = document.createElement("span"), label = document.createElement("span");
    meta.className = "event-meta";
    meta.textContent = `#${event.seq} · ${event.ts ? clockText(event.ts) : "time unknown"}`;
    label.className = "event-label";
    label.textContent = event.label;
    row.append(meta, label);
    return row;
  }));
  elements.eventCoverage.hidden = !live.coverage;
  elements.eventCoverage.textContent = live.coverage;
  elements.liveAiToggle.checked = aiEnabled;
  elements.liveAiToggle.disabled = !live.current || !visible() || !!operationPending;
  elements.liveAiStatus.textContent = aiError ? `Local AI unavailable: ${aiError}. Observed activity and rule-based interpretation continue; no cloud fallback.` :
    aiPending ? "Local AI is interpreting a bounded activity snapshot. Capture and Off remain available." :
    aiEnabled ? "On for this capture. New-event refreshes at most once every 15 seconds." :
    live.current ? "Off. Enable for this capture only." : "Start a capture to enable local AI insights.";
  const result = aiResult?.sessionId === live.sessionId ? aiResult : null;
  elements.liveAiResult.hidden = !result;
  if (result) {
    const historical = !live.current || !aiEnabled;
    const newer = Math.max(0, live.events - result.revision);
    elements.liveAiProvenance.textContent = `${historical ? "Historical local AI hypothesis" : "Local AI hypothesis"} · ${result.model} · ${result.confidence ? `model-rated ${result.confidence} confidence` : "confidence not supplied"}`;
    elements.liveAiSummary.textContent = result.summary;
    elements.liveAiIntent.textContent = `Tentative intent: ${result.intent || "Not established from this snapshot."}`;
    elements.liveAiIssue.hidden = !result.possibleIssue;
    elements.liveAiIssue.textContent = result.possibleIssue ? `Possible issue, unconfirmed: ${result.possibleIssue}` : "";
    elements.liveAiEvidence.textContent = `Analyzed through event #${result.revision}${newer ? ` · ${newer} newer events not analyzed` : ""}. Evidence ${result.evidence.length ? result.evidence.map(seq => `#${seq}`).join(", ") : "not supplied"}. ${result.analyzedAt ? `Analyzed ${clockText(result.analyzedAt)}. ` : ""}Interpretation is not a confirmed finding or ticket.`;
  }
  return live;
}

async function maybeAnalyze() {
  const live = liveView(snapshot, view(), Date.now());
  if (closed || operationPending || !aiEnabled || !visible() || !live.current || live.sessionId !== aiSessionId || aiInFlight || !live.events || live.events <= aiLastAttemptRevision || (aiLastAttemptAt !== null && Date.now() - aiLastAttemptAt < AI_INTERVAL_MS)) return;
  const requestEpoch = epoch, consentEpoch = aiOptInEpoch, sessionId = live.sessionId;
  aiInFlight = true;
  aiPending = true;
  aiError = "";
  aiLastAttemptAt = Date.now();
  aiLastAttemptRevision = live.events;
  const requestedRevision = live.events;
  const request = timedMessage("extension.analyzeLive", 20000, {sessionId, consent: true});
  request.operation.then(() => {aiInFlight = false;}, () => {aiInFlight = false;});
  render();
  const stillAllowed = () => !closed && !operationPending && requestEpoch === epoch && consentEpoch === aiOptInEpoch && aiEnabled && visible() && liveView(snapshot, view(), Date.now()).current && snapshot.live?.sessionId === sessionId;
  try {
    const response = await request.response;
    if (!stillAllowed()) return;
    if (!response?.ok || response.sessionId !== sessionId || response.source !== "local-ai" || response.execution_authorized !== false || !Number.isSafeInteger(response.revision) || response.revision < requestedRevision) throw new Error(response?.error || "No valid local interpretation was confirmed");
    const safeText = value => typeof value === "string" ? value.slice(0, 600) : "";
    aiResult = {sessionId, revision: response.revision, summary: safeText(response.summary), intent: safeText(response.intent), possibleIssue: safeText(response.possibleIssue), model: safeText(response.model).slice(0, 120) || "local model", confidence: ["low", "medium"].includes(response.confidence) ? response.confidence : "", analyzedAt: Number.isFinite(response.analyzedAt) && response.analyzedAt > 0 ? response.analyzedAt : null, evidence: Array.isArray(response.evidence) ? response.evidence.filter(seq => Number.isSafeInteger(seq) && seq > 0 && seq <= response.revision).slice(0, 12) : []};
    aiLastAttemptRevision = Math.max(aiLastAttemptRevision, response.revision);
  } catch (error) {
    if (!stillAllowed()) return;
    aiError = String(error.message || "Local model response failed").slice(0, 180);
  } finally {
    if (consentEpoch === aiOptInEpoch && requestEpoch === epoch) {
      aiPending = false;
      render();
    }
  }
}

function render() {
  const state = view();
  const next = nextStepView(state);
  elements.nextTitle.textContent = next.title;
  elements.nextDetail.textContent = next.detail;
  for (const [id, stage] of [["stepCapture", "capture"], ["stepReview", "review"], ["stepHandoff", "handoff"]]) elements[id].dataset.current = String(next.stage === stage);
  elements.powerStatus.textContent = state.title;
  elements.powerDot.dataset.state = state.power;
  elements.runtimeHelp.textContent = state.runtimeHelp;
  elements.turnOnBtn.hidden = !state.showOn;
  elements.turnOnBtn.disabled = !state.showOn;
  // This lane is never disabled by a pending Stop, cancel, review or status poll.
  elements.turnOffBtn.disabled = state.offDisabled;
  elements.activity.textContent = state.activity;
  elements.activity.dataset.tone = state.tone;
  elements.activityDetail.textContent = state.detail;
  elements.operationStatus.textContent = operationPending;
  elements.operationStatus.hidden = !operationPending;
  const age = checkedAt ? Math.max(0, Math.floor((Date.now() - checkedAt) / 1000)) : 0;
  elements.connectionStatus.textContent = checkedAt ? `${state.fresh ? "Status confirmed" : "Status stale · last confirmation"} ${clockText(checkedAt)} · ${age}s ago` : "No confirmed status yet.";
  elements.connectionStatus.dataset.stale = String(!state.fresh);
  elements.error.textContent = state.error;
  elements.error.hidden = !state.error;
  elements.warning.textContent = state.warning;
  elements.warning.hidden = !state.warning;
  elements.countsHeading.textContent = state.countsHeading;
  elements.eventCount.textContent = String(state.events);
  elements.screenshotCount.textContent = String(state.screenshots);
  elements.historyNote.hidden = !(state.retained && state.historical);
  elements.resultSummary.hidden = !state.hasResult;
  const draftLabel = state.hasReceipts ? (state.drafts === 1 ? "ticket proposal" : "ticket proposals") : (state.drafts === 1 ? "draft ticket" : "draft tickets");
  elements.draftSummary.textContent = `${state.drafts} ${draftLabel}${state.resultHistorical ? " · saved result" : ""}`;
  elements.receiptSummary.hidden = !state.hasReceipts;
  elements.receiptSummary.textContent = `${state.delivered}/${state.ticketTotal} verified delivery receipts${state.stage ? ` · recorded stage: ${state.stage}` : ""}. Historical receipts, not current ticket state.`;
  elements.receiptTime.hidden = !state.hasReceipts;
  elements.receiptTime.textContent = state.receiptCheckedAt ? `Last delivery check: ${new Date(state.receiptCheckedAt).toLocaleString()}. This window does not perform destination readback.` : "No confirmed delivery check time. This window does not perform destination readback.";
  elements.stopBtn.hidden = !state.canStop;
  elements.stopBtn.disabled = !state.canStop || !!operationPending;
  elements.stopBtn.textContent = state.stopLabel;
  elements.cancelBtn.hidden = !state.canCancel;
  elements.cancelBtn.disabled = !state.canCancel || !!operationPending;
  elements.cancelBtn.textContent = state.cancelLabel;
  elements.reviewBtn.hidden = !state.hasResult;
  elements.reviewBtn.disabled = !state.canReview || !!operationPending;
  renderUnderstanding(state);
}

function timedMessage(type, timeoutMs, payload = {}) {
  let timer;
  const operation = Promise.resolve().then(() => chrome.runtime.sendMessage({type, ...payload}));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("The extension response timed out. Completion is unconfirmed; use Turn off if needed.")), timeoutMs);
  });
  return {operation, response: Promise.race([operation, timeout]).finally(() => clearTimeout(timer))};
}

async function poll() {
  if (closed || polling || pendingPower) return;
  polling = true;
  const requestEpoch = epoch;
  const request = timedMessage("extension.getStatus", STATUS_TIMEOUT_MS);
  // Keep one underlying getStatus request in flight even after a timeout.
  // Chromium messaging cannot be aborted. A late reply only releases the lock;
  // it never retroactively becomes a fresh confirmation.
  request.operation.then(() => { polling = false; }, () => { polling = false; });
  try {
    const response = await request.response;
    if (closed || requestEpoch !== epoch || pendingPower) return;
    if (!response?.ok || !response.power) throw new Error(response?.error || "The extension did not return a confirmed runtime state.");
    snapshot = response;
    checkedAt = Date.now();
    connected = true;
    connectionError = "";
  } catch (error) {
    if (closed || requestEpoch !== epoch || pendingPower) return;
    connected = false;
    connectionError = `${error.message} If status does not recover, close and reopen this window.`;
  }
  render();
  maybeAnalyze();
}

async function changePower(on) {
  const state = view();
  if (closed || (on ? !state.showOn : state.offDisabled)) return;
  const requestEpoch = ++epoch;
  disableAI();
  ++operationEpoch;
  operationPending = "";
  operationError = "";
  connectionError = "";
  pendingPower = on ? "starting" : "stopping";
  snapshot = {...snapshot, enabled: false};
  // Preserve the last evidence, but never replay old work as active after a
  // power transition. Only a fresh getStatus can establish current activity.
  if (snapshot.session) snapshot.session = {...snapshot.session, powerPaused: true};
  if (snapshot.result) snapshot.result = {...snapshot.result, powerPaused: true};
  render();
  try {
    const response = await timedMessage(on ? "extension.turnOn" : "extension.turnOff", on ? 20000 : 35000).response;
    if (closed || requestEpoch !== epoch) return;
    if (!response?.power) throw new Error(response?.error || "The runtime did not confirm its state.");
    snapshot = {...snapshot, enabled: false, power: response.power};
    checkedAt = Date.now();
    connected = true;
    if (!response.ok && !response.power.error) operationError = response.error || "The power change was not confirmed.";
  } catch (error) {
    if (closed || requestEpoch !== epoch) return;
    connected = false;
    connectionError = error.message;
  } finally {
    if (!closed && requestEpoch === epoch) {
      pendingPower = null;
      render();
      poll();
    }
  }
}

async function command(type) {
  const state = view();
  const allowed = {"extension.stopRecording": state.canStop, "extension.cancelAutomation": state.canCancel, "extension.openReview": state.canReview};
  if (closed || operationPending || !allowed[type]) return;
  if (type === "extension.cancelAutomation" && !confirm("Cancel remaining automatic delivery? Already delivered tickets and requests in flight cannot be undone.")) return;
  if (type === "extension.stopRecording") disableAI();
  const requestEpoch = epoch, requestOperation = ++operationEpoch;
  operationError = "";
  operationPending = {"extension.stopRecording": "Stop requested. Waiting for the capture result…", "extension.cancelAutomation": "Cancellation requested. Waiting for confirmation…", "extension.openReview": "Opening the saved result…"}[type];
  render();
  try {
    const response = await timedMessage(type, 30000).response;
    if (closed || requestEpoch !== epoch || requestOperation !== operationEpoch) return;
    if (!response?.ok) throw new Error(response?.error || "The operation was not confirmed.");
    // Power is confirmed only by the dedicated status or power lane. In
    // particular, a completed Stop cannot replay an old On state after Off.
    if (response.status) snapshot = {...response, live: response.live === undefined ? snapshot.live : response.live, power: snapshot.power};
  } catch (error) {
    if (closed || requestEpoch !== epoch || requestOperation !== operationEpoch) return;
    operationError = error.message;
  } finally {
    if (!closed && requestEpoch === epoch && requestOperation === operationEpoch) {
      operationPending = "";
      render();
      poll();
    }
  }
}

elements.turnOnBtn.addEventListener("click", () => changePower(true));
elements.turnOffBtn.addEventListener("click", () => changePower(false));
elements.stopBtn.addEventListener("click", () => command("extension.stopRecording"));
elements.cancelBtn.addEventListener("click", () => command("extension.cancelAutomation"));
elements.reviewBtn.addEventListener("click", () => command("extension.openReview"));
elements.liveAiToggle.addEventListener("change", () => {
  const live = liveView(snapshot, view(), Date.now());
  if (!elements.liveAiToggle.checked || !live.current || !visible() || operationPending) disableAI();
  else { aiEnabled = true; ++aiOptInEpoch; aiError = ""; }
  render();
  maybeAnalyze();
});
document.addEventListener("visibilitychange", () => {
  if (!visible()) disableAI();
  render();
  if (visible()) poll();
});
const pollTimer = setInterval(poll, POLL_MS);
const freshnessTimer = setInterval(() => {render(); maybeAnalyze();}, 500);
window.addEventListener("pagehide", () => {
  disableAI();
  closed = true;
  ++epoch;
  clearInterval(pollTimer);
  clearInterval(freshnessTimer);
});
render();
poll();
