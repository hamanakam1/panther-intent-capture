import { BACKEND_ORIGIN, backendReadiness, workerReadiness, UPDATE_GUIDANCE } from "../shared/constants.js";
import { loadConsentLog } from "../shared/audit.js";

const elements = Object.fromEntries(["status", "powerStatus", "powerHelp", "powerError", "monitorBtn", "monitorError", "setupNeeded", "extensionId", "turnOnBtn", "turnOffBtn", "consent", "goal", "screenshots", "automation", "automationAI", "automationTarget", "automationDestination", "recordBtn", "stopBtn", "retryBtn", "generateBtn", "refreshAutomationBtn", "retryAutomationBtn", "cancelAutomationBtn", "reviewBtn", "discardBtn", "meta", "warning", "error", "log", "backendBanner", "previewNotice", "nextTitle", "nextDetail", "pageLabel", "pageTitle", "pageDetail", "captureSetup", "consentHelp", "metricScope", "eventMetric", "screenshotMetric", "draftMetric", "sessionNote", "optionSummary", "recentStatus", "recentCaptures", "helperHealth", "refreshStatus", "newCaptureBtn", "goalContext", "capturedGoal", "workerReadiness", "loadedVersions"].map((id) => [id, document.getElementById(id)]));
const browserAvailable = typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function" && !!chrome.runtime.id;
let current = { status: "idle", enabled: false, power: {state: "off", error: ""} };
let busy = false;
let operationError = "";
let pendingConsent = null;
let automationTarget = "";
let automationKind = "";
let destinationList = [];
let targetError = "";
let pendingPower = null;
let powerEpoch = 0;
let statusRequest = 0;
let operationRequest = 0;
let connectionVersion = 0;
let connectionActive = false;
let openingMonitor = false;
let monitorError = "";
let statusConfirmed = false;
let preparingCapture = false;
let selectedPage = null;
let pageChecked = false;
let healthState = "unknown";
let recentRequest = 0;
let healthCheck = 0;
let backend = backendReadiness(null);

const runtimeState = () => pendingPower || current.power?.state || "off";
const isOn = () => browserAvailable && runtimeState() === "on";

function pageName(url) {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.hostname + parsed.pathname : "Browser page"; }
  catch { return "Page address unavailable"; }
}

function deliveryInProgress(result) {
  return !!result?.automationPolicy && (!["delivered", "blocked", "cancelled"].includes(result.automation?.status) || !!result.error || result.cancelRequested === true);
}

function renderDashboard() {
  const on = isOn(), session = current.session, result = current.result;
  const historical = !on && !!(session || result);
  const recording = on && current.status === "recording";
  let title = "Choose one workflow to improve", detail = "Describe the outcome, allow capture, then Start when you are ready.";
  if (!browserAvailable) { title = "Open Panther from your toolbar"; detail = "This web preview cannot read browser status or start a capture. Use the installed extension on a webpage."; }
  else if (!statusConfirmed) { title = "Checking your capture status"; detail = "Waiting for the extension. Opening this popup does not start capture."; }
  else if (runtimeState() === "error") { title = current.power?.configured === false ? "Connect the browser helper" : "Check the connection"; detail = "Capture is unavailable until the runtime is confirmed. See connection details below, then try again."; }
  else if (runtimeState() === "starting") { title = "Starting the local service"; detail = "Capture will still need your consent and a separate Start."; }
  else if (runtimeState() === "stopping") { title = "Turning Panther off"; detail = "Capture is stopping. Retained events are kept; an in-flight delivery may still finish."; }
  else if (!on) { title = historical ? "Your previous work is retained" : "Start with one clear intention"; detail = "Turn Panther on to prepare a capture. Nothing records until you allow capture and press Start."; }
  else if (recording) { title = "Work through your chosen page"; detail = "Panther is capturing this workflow. Stop when you have shown the behavior you want to improve."; }
  else if (current.status === "pending") { title = "Save your retained capture"; detail = "The events are still in this browser. Retry upload after the connection is restored, or discard them explicitly."; }
  else if (["saving", "generating"].includes(current.status)) { title = current.status === "saving" ? "Saving your captured evidence" : "Preparing reviewable drafts"; detail = "Wait for the saved result. You can still turn Panther off; no draft authorizes work execution."; }
  else if (current.status === "error") { title = "Your saved capture needs attention"; detail = "Read the message below. Retry draft generation, or open the saved capture to inspect its evidence."; }
  else if (result?.automationPolicy) { title = "Check this session’s delivery"; detail = "The delivery status below comes from this session’s consent. Review receipts before assuming a ticket was sent."; }
  else if (result?.id) { title = "Review what happened"; detail = "Check the saved evidence, edit the drafts, then choose whether to share an intent bundle with Companion."; }
  else if (pageChecked && selectedPage?.eligible === false) { title = "Choose a regular webpage"; detail = "Capture works on ordinary HTTP or HTTPS pages, not browser settings, extension pages or local files."; }
  else if (!current.enabled) { title = "Set a goal and allow capture"; detail = "Your consent applies to the chosen page. Start is a separate action."; }
  elements.nextTitle.textContent = title; elements.nextDetail.textContent = detail;
  elements.previewNotice.hidden = browserAvailable;
  elements.pageLabel.textContent = session ? (historical ? "RETAINED CAPTURE PAGE" : "CAPTURED PAGE") : "SELECTED PAGE";
  elements.pageTitle.textContent = session?.url ? pageName(session.url) : selectedPage?.title || (!browserAvailable ? "Available in the toolbar extension" : pageChecked ? "Select a webpage in this window" : "Checking the selected tab…");
  elements.pageTitle.title = elements.pageTitle.textContent;
  elements.pageDetail.textContent = session ? (historical ? "Historical page · capture is not running" : "This session stays with its chosen tab.") : selectedPage?.eligible ? pageName(selectedPage.url) : pageChecked ? "Browser and extension pages cannot be captured." : "";
  elements.captureSetup.hidden = !on || (resultReady(current) && !preparingCapture) || !!session || ["saving", "generating"].includes(current.status) || deliveryInProgress(result);
  elements.consentHelp.textContent = !on ? "Turn on first. Then allow capture and choose Start. Typed values and keystrokes stay out." : current.enabled ? "Capture is allowed; it starts only when you press Start." : "Clicks, navigation and control labels. No typed values or keystrokes.";
  const counts = session || result;
  elements.goalContext.hidden = !counts || preparingCapture;
  elements.capturedGoal.textContent = counts && Object.hasOwn(counts, "goal")
    ? counts.goal || "No goal was supplied for this capture."
    : "The loaded extension worker did not supply this capture’s goal. Review the saved capture for its context.";
  const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : "—";
  elements.metricScope.textContent = historical ? "RETAINED INFORMATION · NOT LIVE" : session ? "CURRENT SESSION" : result ? "LAST SAVED CAPTURE" : "NO CAPTURE YET";
  elements.eventMetric.textContent = count(counts?.eventCount);
  elements.screenshotMetric.textContent = count(counts?.screenshotCount);
  elements.draftMetric.textContent = session ? "—" : count(result?.automationPolicy ? result.automation?.ticket_count : result?.ticketCount);
  elements.sessionNote.textContent = historical ? "These counts are historical. No capture is running while Panther is off." : session ? (recording ? "Events are captured from the chosen page only." : "Events are retained until upload is confirmed.") : result ? "Saved evidence and proposals still need your review." : "Capture one workflow to create an evidence draft.";
  elements.optionSummary.textContent = `${elements.screenshots.checked ? "Screenshots on" : "Screenshots off"} · ${elements.automation.checked ? "Delivery on" : "Delivery off"}`;
  elements.helperHealth.textContent = !browserAvailable ? "Toolbar extension required" : !statusConfirmed ? "Checking browser status…" : current.power?.configured === false && runtimeState() === "error" ? "Browser helper not connected" : !on ? "Local service is off or unconfirmed" : healthState === "available" ? "Local service connected" : healthState === "unavailable" ? "Local service unreachable" : "Checking local service…";
  elements.refreshStatus.disabled = !browserAvailable;
  elements.workerReadiness.hidden = !browserAvailable || !statusConfirmed || workerReadiness(current.worker);
  elements.workerReadiness.textContent = "The loaded capture worker needs an update. New captures are paused; Stop, Off and retained-capture recovery remain available. " + UPDATE_GUIDANCE;
  elements.loadedVersions.textContent = `Loaded extension: ${browserAvailable ? chrome.runtime.getManifest?.().version || "unknown" : "unavailable"} · Loaded capture worker: ${current.worker?.app_version || "unknown"} · Running backend: ${on ? backend.version : "not checked while Off"}. Source files do not confirm loaded versions.`;
}

function renderPower() {
  const state = runtimeState();
  const power = current.power || {};
  elements.powerStatus.textContent = ({off: "Panther is off", starting: "Turning Panther on…", on: "Panther is on", stopping: "Turning Panther off…", error: "Panther needs attention"})[state] || "Panther state is unknown";
  elements.turnOnBtn.hidden = ["on", "starting", "stopping"].includes(state);
  elements.turnOnBtn.disabled = !browserAvailable || !statusConfirmed || state === "stopping";
  elements.turnOffBtn.hidden = state === "off";
  // Off has its own request lane: capture, generation and upload cannot disable it.
  elements.turnOffBtn.disabled = !browserAvailable || state === "off" || state === "stopping";
  elements.powerHelp.textContent = ({
    off: "The browser-controlled backend is off. Turn on to use Panther; then grant fresh capture consent. Saved information below is historical.",
    starting: "Starting the local backend only. No capture starts automatically. You can turn Panther off while it starts.",
    on: "Capture needs consent and Start. Stop & deliver leaves Panther on. Nothing starts at login.",
    stopping: "Stopping capture and cancelling remaining automatic delivery. Unsaved events are retained; a request already in flight may finish.",
    error: "The runtime could not confirm its state. Capture and delivery are disabled. Use Turn off to stop any owned backend, or follow setup instructions."
  })[state] || "Capture and delivery are disabled until the runtime state is confirmed.";
  elements.powerError.textContent = power.error || "";
  elements.powerError.hidden = !power.error || !!pendingPower;
  elements.monitorBtn.disabled = !browserAvailable || openingMonitor;
  elements.monitorBtn.textContent = openingMonitor ? "Opening status window…" : "Open status window";
  elements.monitorError.textContent = monitorError || current.monitorError || "";
  elements.monitorError.hidden = !elements.monitorError.textContent;
  elements.setupNeeded.hidden = !(state === "error" && power.configured === false);
  elements.extensionId.textContent = browserAvailable ? chrome.runtime.id : "Available from the installed toolbar extension.";
  if (!browserAvailable) { elements.powerStatus.textContent = "Web preview only"; elements.powerHelp.textContent = "Use the browser toolbar for capture and runtime controls. This preview makes no extension or backend requests."; }
  else if (!statusConfirmed) elements.powerStatus.textContent = "Checking Panther…";
}

function syncConnections() {
  if (!isOn()) {
    if (connectionActive) ++connectionVersion;
    connectionActive = false;
    automationTarget = ""; targetError = "";
    elements.backendBanner.hidden = true;
    healthState = "unknown"; backend = backendReadiness(null);
    elements.recentCaptures.replaceChildren();
    elements.recentStatus.textContent = browserAvailable ? "Turn on to load saved captures. No service request is made while off." : "Saved captures appear here in the toolbar extension.";
    return;
  }
  if (connectionActive) return;
  connectionActive = true;
  const version = ++connectionVersion;
  healthState = "checking";
  checkBackend(version);
  loadRecent(version);
  chrome.runtime.sendMessage({type: "extension.getAutomationTarget"}).then(response => {
    if (version !== connectionVersion || !isOn()) return;
    if (!response?.ok) throw new Error(response?.error || "Delivery destinations are unknown.");
    let destinations = response.destinations;
    // An already-loaded older worker exposes only its configured ticket service.
    // Its URL is configuration, not proof that the destination is reachable.
    if (!Array.isArray(destinations) && typeof response.url === "string") {
      const url = new URL(response.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("The configured delivery address is invalid.");
      destinations = [{kind: "ticket-service", label: "Local ticket service", url: response.url, configured: true, available: false, state: "unknown"}];
    }
    if (!Array.isArray(destinations)) throw new Error("Delivery destinations are unknown.");
    renderDestinations(destinations);
    render(current);
  }).catch(error => {
    if (version !== connectionVersion || !isOn()) return;
    targetError = `Automatic delivery unavailable: ${error.message}`;
    render(current);
  });
}

/**
 * Show every delivery destination and let one be chosen explicitly.
 *
 * A destination that is not configured is still listed so the reason is
 * visible, but it cannot be selected. The chosen destination and its
 * canonical target are frozen for the session once consent is given.
 */
function renderDestinations(list) {
  const previous = elements.automationDestination.value;
  destinationList = list;
  elements.automationDestination.replaceChildren(...list.map((destination) => {
    const option = document.createElement("option");
    option.value = destination.kind;
    option.textContent = destination.available ? `${destination.label} — ${destination.url}`
      : destination.configured ? `${destination.label} — ${destination.url} (${destination.state === "unknown" ? "reachability not checked" : "not reachable right now"})`
        : `${destination.label} — not configured`;
    option.disabled = !destination.configured;
    return option;
  }));
  const usable = list.filter((destination) => destination.configured);
  const chosen = usable.find((destination) => destination.kind === previous) || usable[0];
  if (!chosen) {
    const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "No destination configured"; placeholder.disabled = true;
    elements.automationDestination.replaceChildren(placeholder);
  }
  elements.automationDestination.value = chosen ? chosen.kind : "";
  elements.automationDestination.hidden = list.length < 2;
  automationTarget = chosen ? chosen.url : "";
  automationKind = chosen ? chosen.kind : "";
  targetError = chosen ? "" : "No delivery destination is configured. Manual capture and JSON export still work.";
}

function showError(message = "") {
  elements.error.textContent = message;
  elements.error.hidden = !message;
}

function render(state) {
  const finishedSession = current.session && !state.session;
  const refreshRecents = connectionActive && current.result?.id !== state.result?.id;
  if (current.result?.id !== state.result?.id) preparingCapture = false;
  current = state;
  renderPower();
  syncConnections();
  if (refreshRecents && isOn()) loadRecent(connectionVersion);
  const on = isOn();
  const recording = state.status === "recording";
  const pending = state.status === "pending";
  const working = ["saving", "generating"].includes(state.status);
  const job = state.result?.automation;
  const automatic = !!state.result?.automationPolicy;
  const deliveryActive = deliveryInProgress(state.result);
  const sessionAutomatic = !!state.session?.automation && !state.session?.automationWithdrawn;
  const labels = { idle: "Ready to capture", recording: "Capturing", saving: "Saving…", pending: "Upload pending", generating: "Generating drafts…", ready: "Drafts ready", error: "Needs retry" };
  const deliveryLabels = { queued: "Delivery queued", generating: "Generating tickets…", delivering: "Delivering tickets…", retry_wait: "Delivery retry scheduled", delivered: "Tickets delivered", blocked: "Delivery blocked", cancelled: "Delivery cancelled" };
  elements.status.textContent = !browserAvailable ? "Preview only" : !statusConfirmed ? "Checking…" : !on ? (state.session ? "Capture retained" : state.result ? "Saved information" : "Capture off") : automatic ? (state.result.error ? "Delivery status needs attention" : deliveryLabels[job?.status] || "Checking delivery…") : labels[state.status] || state.status;
  elements.status.className = "status" + (on && recording ? " recording" : "");
  elements.consent.checked = on && (pendingConsent === null ? state.enabled === true : pendingConsent);
  elements.consent.disabled = !on || busy || working;
  elements.goal.disabled = !on || !!state.session || busy || working;
  elements.screenshots.disabled = !on || !!state.session || busy || working;
  if (state.session) elements.screenshots.checked = state.session.screenshotsConsent === true;
  else if (finishedSession) elements.screenshots.checked = false;
  if (state.session) {
    elements.automation.checked = sessionAutomatic;
    elements.automationAI.checked = sessionAutomatic && state.session.automation.use_ai === true;
  } else if (finishedSession) {
    elements.automation.checked = false;
    elements.automationAI.checked = false;
  }
  elements.automation.disabled = !on || !!state.session || busy || working || deliveryActive || !automationTarget;
  elements.automationAI.disabled = !on || !elements.automation.checked || !!state.session || busy || working || deliveryActive;
  const displayedTarget = state.session?.automation?.target_url || (deliveryActive ? state.result.automationPolicy.target_url : automationTarget);
  const displayedKind = state.session?.automation?.target_kind || (deliveryActive ? state.result.automationPolicy.target_kind : automationKind);
  const unknownReachability = destinationList.find(destination => destination.kind === displayedKind)?.state === "unknown";
  elements.automationTarget.textContent = displayedTarget ? `Destination: ${displayedTarget}${displayedKind ? ` (${displayedKind})` : ""}${state.session || deliveryActive ? " · fixed for this session" : unknownReachability ? " · reachability not checked" : ""}${on ? "" : " · historical; Panther is not on"}` : !on ? "Turn Panther on to check the destination. No backend request is made while off." : targetError || "Automatic delivery unavailable: destination is unknown. Manual capture still works.";
  elements.newCaptureBtn.hidden = !on || !resultReady(state) || deliveryActive || preparingCapture || working;
  elements.newCaptureBtn.disabled = busy;
  elements.recordBtn.hidden = !on || !!state.session || working || deliveryActive || (resultReady(state) && !preparingCapture);
  elements.recordBtn.disabled = !on || !workerReadiness(state.worker) || !state.enabled || busy || working || deliveryActive || (pageChecked && selectedPage?.eligible === false) || (elements.automation.checked && !automationTarget);
  elements.recordBtn.textContent = resultReady(state) ? "Start another capture" : "Start capture";
  elements.recordBtn.className = resultReady(state) ? "btn" : "btn primary";
  elements.stopBtn.hidden = !recording;
  elements.stopBtn.textContent = sessionAutomatic ? "Stop & deliver tickets" : "Stop & generate drafts";
  elements.stopBtn.disabled = !on || busy;
  elements.retryBtn.hidden = !pending;
  elements.retryBtn.disabled = !on || busy || state.session?.cancelRequested === true || state.session?.cancellationConfirmed === true;
  elements.retryBtn.textContent = sessionAutomatic ? "Retry upload & deliver" : "Retry upload";
  elements.discardBtn.hidden = !pending;
  elements.discardBtn.disabled = busy || (sessionAutomatic && state.session.uploadAttempts > 0);
  elements.generateBtn.hidden = !(state.status === "error" && state.result);
  elements.generateBtn.disabled = !on || busy;
  elements.refreshAutomationBtn.hidden = !automatic && !(sessionAutomatic && state.session.uploadAttempts > 0);
  elements.refreshAutomationBtn.disabled = !on || busy;
  elements.refreshAutomationBtn.textContent = state.session ? "Check upload / delivery" : "Check delivery status";
  elements.retryAutomationBtn.hidden = !automatic || job?.status !== "retry_wait" || !!state.result?.error || state.result?.cancelRequested === true;
  elements.retryAutomationBtn.disabled = !on || busy;
  elements.cancelAutomationBtn.hidden = !sessionAutomatic && !deliveryActive;
  elements.cancelAutomationBtn.disabled = !on || busy || working;
  elements.cancelAutomationBtn.textContent = state.session?.cancelRequested || state.result?.cancelRequested ? "Check cancellation" : "Cancel automatic delivery";
  elements.reviewBtn.hidden = !state.result?.id;
  elements.reviewBtn.disabled = !on || busy;
  elements.meta.textContent = state.session ?
    `${state.session.eventCount} events · ${state.session.screenshotCount} screenshots · started ${new Date(state.session.startTime).toLocaleTimeString()}` :
    automatic ? `${state.result.eventCount} events saved · ${job?.delivered_count || 0}/${job?.ticket_count || 0} verified delivery receipts · ${job?.stage || "status unknown"} · ${state.result.automationPolicy.target_url}. Receipts are historical, not current ticket state. Review-only backlog; no work execution.${state.result.automationCheckedAt ? ` Last status check ${new Date(state.result.automationCheckedAt).toLocaleTimeString()}.` : ""}` :
    state.result ? `${state.result.eventCount} events saved · ${state.result.ticketCount || 0} draft tickets. Review before sending to another system.` :
      "The page panel shows capture status and basic controls.";
  showError(state.session?.error || state.result?.error || job?.error || operationError);
  elements.warning.textContent = state.session?.warning || state.result?.warning || "";
  elements.warning.hidden = !elements.warning.textContent;
  renderDashboard();
}

function resultReady(state) { return !!state.result?.id && !state.session; }

async function renderLog() {
  const log = await loadConsentLog();
  elements.log.replaceChildren(...log.slice(-8).reverse().map((entry) => {
    const row = document.createElement("div");
    row.className = "log-entry";
    row.textContent = `${new Date(entry.ts).toLocaleTimeString()} · ${entry.action.replaceAll("_", " ")}`;
    return row;
  }));
  if (!log.length) elements.log.textContent = "No consent actions recorded yet.";
}

async function refresh() {
  if (!browserAvailable) return;
  const request = ++statusRequest, epoch = powerEpoch;
  try {
    const state = await chrome.runtime.sendMessage({ type: "extension.getStatus" });
    if (request !== statusRequest || epoch !== powerEpoch) return;
    if (!state?.ok) throw new Error(state?.error || "Capture worker did not respond.");
    statusConfirmed = true;
    render(state);
    await renderLog();
  } catch (error) {
    if (request !== statusRequest || epoch !== powerEpoch) return;
    statusConfirmed = true;
    render({...current, power: {state: "error", error: error.message, configured: current.power?.configured}});
  }
}

async function command(type, fields = {}) {
  const localOnly = type === "extension.discardCapture";
  if (!isOn() && !localOnly) { showError("Turn Panther on before using capture or delivery controls."); return; }
  if (busy) return;
  const request = ++operationRequest, epoch = powerEpoch;
  operationError = "";
  const changesConsent = type === "extension.setEnabled";
  if (changesConsent) pendingConsent = fields.enabled === true;
  busy = true;
  render(current);
  try {
    const response = await chrome.runtime.sendMessage({ type, ...fields });
    if (request !== operationRequest || epoch !== powerEpoch) return;
    if (response?.status) render(response);
    if (!response?.ok) throw new Error(response?.error || "The operation did not complete.");
    await refresh();
  } catch (error) { if (request === operationRequest && epoch === powerEpoch) operationError = error.message; }
  finally {
    if (request !== operationRequest || epoch !== powerEpoch) return;
    if (changesConsent) pendingConsent = null;
    busy = false;
    render(current);
  }
}

async function changePower(on) {
  if (!browserAvailable) return;
  if ((!on && runtimeState() === "stopping") || (on && !["off", "error"].includes(runtimeState()))) return;
  const epoch = ++powerEpoch;
  ++statusRequest; ++operationRequest;
  busy = false; pendingConsent = null; operationError = ""; preparingCapture = false;
  pendingPower = on ? "starting" : "stopping";
  current = {...current, enabled: false, power: {...current.power, error: ""}};
  elements.screenshots.checked = false; elements.automation.checked = false; elements.automationAI.checked = false;
  render(current);
  try {
    const response = await chrome.runtime.sendMessage({type: on ? "extension.turnOn" : "extension.turnOff"});
    if (epoch !== powerEpoch) return;
    pendingPower = null;
    if (!response?.power) throw new Error(response?.error || "The runtime did not confirm its power state.");
    render({...current, enabled: false, power: response.power, monitorError: response.monitorError || ""});
    if (!response.ok && !response.power.error) throw new Error(response.error || "The runtime operation did not complete.");
    await refresh();
  } catch (error) {
    if (epoch !== powerEpoch) return;
    pendingPower = null;
    render({...current, enabled: false, power: {state: "error", error: error.message, configured: current.power?.configured}});
  }
}

elements.monitorBtn.addEventListener("click", async () => {
  if (openingMonitor) return;
  openingMonitor = true; monitorError = "";
  renderPower();
  try {
    const response = await chrome.runtime.sendMessage({type: "extension.openMonitor"});
    if (!response?.ok || response.monitorError) throw new Error(response?.monitorError || response?.error || "The status window could not open.");
    current = {...current, monitorError: ""};
  } catch (error) { monitorError = `Status window: ${error.message} Use this popup's power controls.`; }
  finally { openingMonitor = false; renderPower(); }
});
elements.turnOnBtn.addEventListener("click", () => changePower(true));
elements.turnOffBtn.addEventListener("click", () => changePower(false));
elements.consent.addEventListener("change", () => command("extension.setEnabled", { enabled: elements.consent.checked }));
elements.automation.addEventListener("change", () => {
  if (!elements.automation.checked) elements.automationAI.checked = false;
  render(current);
});
elements.screenshots.addEventListener("change", renderDashboard);
elements.automationDestination.addEventListener("change", () => {
  const chosen = destinationList.find((destination) => destination.kind === elements.automationDestination.value);
  automationKind = chosen?.kind || "";
  automationTarget = chosen?.configured ? chosen.url : "";
  render(current);
});
elements.newCaptureBtn.addEventListener("click", () => {
  if (!isOn() || busy || deliveryInProgress(current.result)) return;
  preparingCapture = true; render(current); elements.goal.focus?.();
});
elements.recordBtn.addEventListener("click", async () => {
  const epoch = powerEpoch;
  if (!isOn()) return;
  await refresh();
  if (!workerReadiness(current.worker)) { showError("New capture is paused until the loaded worker is compatible. " + UPDATE_GUIDANCE); return; }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (epoch !== powerEpoch || !isOn()) return;
    if (!tab?.id) throw new Error("Choose a webpage to capture.");
    if (tab.url && !/^https?:\/\//i.test(tab.url)) throw new Error("Choose an ordinary HTTP or HTTPS webpage. Browser and extension pages cannot be captured.");
    const automation = elements.automation.checked ? { enabled: true, consent: true, target_kind: automationKind, target_url: automationTarget, use_ai: elements.automationAI.checked, max_tickets: 5 } : undefined;
    await command("extension.startRecording", { tabId: tab.id, consent: elements.consent.checked, screenshots: elements.screenshots.checked, goal: elements.goal.value, automation });
  } catch (error) { showError(error.message); }
});
elements.stopBtn.addEventListener("click", () => command("extension.stopRecording"));
elements.retryBtn.addEventListener("click", () => command("extension.retryUpload"));
elements.generateBtn.addEventListener("click", () => command("extension.retryGeneration"));
elements.refreshAutomationBtn.addEventListener("click", () => command("extension.refreshAutomation"));
elements.retryAutomationBtn.addEventListener("click", () => command("extension.retryAutomation"));
elements.cancelAutomationBtn.addEventListener("click", () => command("extension.cancelAutomation"));
elements.reviewBtn.addEventListener("click", () => command("extension.openReview"));
elements.discardBtn.addEventListener("click", () => {
  if (confirm("Discard this capture from the browser? Its events cannot be recovered.")) command("extension.discardCapture");
});

async function checkBackend(version) {
  const check = ++healthCheck;
  try {
    const response = await fetch(`${BACKEND_ORIGIN}/api/extension/health`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    const health = response.ok ? await response.json() : null;
    if (check !== healthCheck || version !== connectionVersion || !isOn()) return;
    backend = backendReadiness(health);
    healthState = backend.connected ? "available" : "unavailable";
    elements.backendBanner.hidden = backend.ready;
    elements.backendBanner.textContent = backend.connected
      ? "The local service needs an update before draft editing or Companion export. " + UPDATE_GUIDANCE
      : "Could not confirm the local service. Retained capture stays in this browser. Check the connection, then retry upload.";
  } catch {
    if (check !== healthCheck || version !== connectionVersion || !isOn()) return;
    backend = backendReadiness(null);
    elements.backendBanner.hidden = false; healthState = "unavailable";
    elements.backendBanner.textContent = "Could not confirm the local service. Retained capture stays in this browser. Check the connection, then retry upload.";
  }
  renderDashboard();
}

async function loadRecent(version) {
  if (!isOn()) return;
  const request = ++recentRequest;
  elements.recentStatus.textContent = "Loading saved captures…";
  try {
    const response = await fetch(`${BACKEND_ORIGIN}/api/extension/recordings`, {signal: AbortSignal.timeout(3000)});
    if (!response.ok) throw new Error("The saved capture list could not be loaded.");
    const data = await response.json();
    if (request !== recentRequest || version !== connectionVersion || !isOn()) return;
    if (!Array.isArray(data.recordings)) throw new Error("The service returned an incomplete capture list.");
    const recent = data.recordings.slice(0, 3);
    elements.recentCaptures.replaceChildren(...recent.map(capture => {
      const link = document.createElement("a"); link.className = "recent-item";
      link.href = `../options/options.html?recording=${encodeURIComponent(capture.id)}`; link.target = "_blank"; link.rel = "noopener";
      const title = document.createElement("strong"); title.textContent = capture.title || "Saved browser capture"; title.title = title.textContent;
      const detail = document.createElement("span"); detail.textContent = `${Number.isSafeInteger(capture.event_count) ? capture.event_count : "?"} events · ${Number.isFinite(capture.start_time) ? new Date(capture.start_time * 1000).toLocaleDateString() : "Saved date unknown"}`;
      link.append(title, detail); return link;
    }));
    elements.recentStatus.textContent = recent.length ? "Saved on this computer · select one to review" : "No saved captures yet. Start with one workflow on your chosen page.";
  } catch {
    if (request !== recentRequest || version !== connectionVersion || !isOn()) return;
    elements.recentCaptures.replaceChildren();
    elements.recentStatus.textContent = "Saved captures are unavailable. Check the local connection and choose Refresh.";
  }
}

async function checkSelectedPage() {
  if (!browserAvailable) return;
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    selectedPage = tab ? {title: tab.title || pageName(tab.url), url: tab.url, eligible: tab.url ? /^https?:\/\//i.test(tab.url) : null} : null;
  } catch { selectedPage = null; }
  pageChecked = true;
  render(current);
}

elements.refreshStatus.addEventListener("click", async () => {
  if (!browserAvailable) return;
  await refresh();
  if (isOn()) { checkBackend(connectionVersion); loadRecent(connectionVersion); }
  checkSelectedPage();
});
render(current);
if (browserAvailable) {
  checkSelectedPage();
  refresh();
  setInterval(refresh, 1200);
}
