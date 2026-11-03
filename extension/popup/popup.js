import { BACKEND_ORIGIN } from "../shared/constants.js";
import { loadConsentLog } from "../shared/audit.js";

const elements = Object.fromEntries(["status", "powerStatus", "powerHelp", "powerError", "monitorBtn", "monitorError", "setupNeeded", "extensionId", "turnOnBtn", "turnOffBtn", "consent", "goal", "screenshots", "automation", "automationAI", "automationTarget", "automationDestination", "recordBtn", "stopBtn", "retryBtn", "generateBtn", "refreshAutomationBtn", "retryAutomationBtn", "cancelAutomationBtn", "reviewBtn", "discardBtn", "meta", "warning", "error", "log", "backendBanner"].map((id) => [id, document.getElementById(id)]));
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

const runtimeState = () => pendingPower || current.power?.state || "off";
const isOn = () => runtimeState() === "on";

function renderPower() {
  const state = runtimeState();
  const power = current.power || {};
  elements.powerStatus.textContent = ({off: "Panther is off", starting: "Turning Panther on…", on: "Panther is on", stopping: "Turning Panther off…", error: "Panther needs attention"})[state] || "Panther state is unknown";
  elements.turnOnBtn.hidden = ["on", "starting", "stopping"].includes(state);
  elements.turnOnBtn.disabled = state === "stopping";
  elements.turnOffBtn.hidden = state === "off";
  // Off has its own request lane: capture, generation and upload cannot disable it.
  elements.turnOffBtn.disabled = state === "off" || state === "stopping";
  elements.powerHelp.textContent = ({
    off: "The browser-controlled backend is off. Turn on to use Panther; then grant fresh capture consent. Saved information below is historical.",
    starting: "Starting the local backend only. No capture starts automatically. You can turn Panther off while it starts.",
    on: "The local backend is on. Capture still needs consent and Start. Stop & deliver leaves Panther on; nothing is installed to start at login.",
    stopping: "Stopping capture and cancelling remaining automatic delivery. Unsaved events are retained; a request already in flight may finish.",
    error: "The runtime could not confirm its state. Capture and delivery are disabled. Use Turn off to stop any owned backend, or follow setup instructions."
  })[state] || "Capture and delivery are disabled until the runtime state is confirmed.";
  elements.powerError.textContent = power.error || "";
  elements.powerError.hidden = !power.error || !!pendingPower;
  elements.monitorBtn.disabled = openingMonitor;
  elements.monitorBtn.textContent = openingMonitor ? "Opening status window…" : "Open status window";
  elements.monitorError.textContent = monitorError || current.monitorError || "";
  elements.monitorError.hidden = !elements.monitorError.textContent;
  elements.setupNeeded.hidden = !(state === "error" && power.configured === false);
  elements.extensionId.textContent = chrome.runtime.id || "Open this popup from the installed Panther extension to read its ID.";
}

function syncConnections() {
  if (!isOn()) {
    if (connectionActive) ++connectionVersion;
    connectionActive = false;
    automationTarget = ""; targetError = "";
    elements.backendBanner.hidden = true;
    return;
  }
  if (connectionActive) return;
  connectionActive = true;
  const version = ++connectionVersion;
  checkBackend(version);
  chrome.runtime.sendMessage({type: "extension.getAutomationTarget"}).then(response => {
    if (version !== connectionVersion || !isOn()) return;
    if (!response?.ok || !Array.isArray(response.destinations)) throw new Error(response?.error || "Delivery destinations are unknown.");
    renderDestinations(response.destinations);
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
      : destination.configured ? `${destination.label} — ${destination.url} (not reachable right now)`
        : `${destination.label} — not configured`;
    option.disabled = !destination.configured;
    return option;
  }));
  const usable = list.filter((destination) => destination.configured);
  const chosen = usable.find((destination) => destination.kind === previous) || usable[0];
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
  current = state;
  renderPower();
  syncConnections();
  const on = isOn();
  const recording = state.status === "recording";
  const pending = state.status === "pending";
  const working = ["saving", "generating"].includes(state.status);
  const job = state.result?.automation;
  const automatic = !!state.result?.automationPolicy;
  const terminal = ["delivered", "blocked", "cancelled"].includes(job?.status);
  const deliveryActive = automatic && (!terminal || !!state.result.error || state.result.cancelRequested === true);
  const sessionAutomatic = !!state.session?.automation && !state.session?.automationWithdrawn;
  const labels = { idle: "Ready to capture", recording: "Capturing", saving: "Saving…", pending: "Upload pending", generating: "Generating drafts…", ready: "Drafts ready", error: "Needs retry" };
  const deliveryLabels = { queued: "Delivery queued", generating: "Generating tickets…", delivering: "Delivering tickets…", retry_wait: "Delivery retry scheduled", delivered: "Tickets delivered", blocked: "Delivery blocked", cancelled: "Delivery cancelled" };
  elements.status.textContent = !on ? (state.session ? "Capture retained" : state.result ? "Saved information" : "Capture off") : automatic ? (state.result.error ? "Delivery status needs attention" : deliveryLabels[job?.status] || "Checking delivery…") : labels[state.status] || state.status;
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
  elements.automationTarget.textContent = displayedTarget ? `Destination: ${displayedTarget}${displayedKind ? ` (${displayedKind})` : ""}${state.session || deliveryActive ? " · fixed for this session" : ""}${on ? "" : " · historical; Panther is not on"}` : !on ? "Turn Panther on to check the destination. No backend request is made while off." : targetError || "Automatic delivery unavailable: destination is unknown. Manual capture still works.";
  elements.recordBtn.hidden = !!state.session || working || deliveryActive;
  elements.recordBtn.disabled = !on || !state.enabled || busy || working || deliveryActive || (elements.automation.checked && !automationTarget);
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
}

async function renderLog() {
  const log = await loadConsentLog();
  elements.log.replaceChildren(...log.slice(-8).reverse().map((entry) => {
    const row = document.createElement("div");
    row.className = "log-entry";
    row.textContent = `${new Date(entry.ts).toLocaleTimeString()} · ${entry.action.replaceAll("_", " ")}`;
    return row;
  }));
}

async function refresh() {
  const request = ++statusRequest, epoch = powerEpoch;
  try {
    const state = await chrome.runtime.sendMessage({ type: "extension.getStatus" });
    if (request !== statusRequest || epoch !== powerEpoch) return;
    if (!state?.ok) throw new Error(state?.error || "Capture worker did not respond.");
    render(state);
    await renderLog();
  } catch (error) {
    if (request !== statusRequest || epoch !== powerEpoch) return;
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
  if ((!on && runtimeState() === "stopping") || (on && !["off", "error"].includes(runtimeState()))) return;
  const epoch = ++powerEpoch;
  ++statusRequest; ++operationRequest;
  busy = false; pendingConsent = null; operationError = "";
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
elements.automationDestination.addEventListener("change", () => {
  const chosen = destinationList.find((destination) => destination.kind === elements.automationDestination.value);
  automationKind = chosen?.kind || "";
  automationTarget = chosen?.configured ? chosen.url : "";
  render(current);
});
elements.recordBtn.addEventListener("click", async () => {
  const epoch = powerEpoch;
  if (!isOn()) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (epoch !== powerEpoch || !isOn()) return;
    if (!tab?.id) throw new Error("Choose a webpage to capture.");
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
  try {
    const response = await fetch(`${BACKEND_ORIGIN}/api/extension/health`, { signal: AbortSignal.timeout(3000) });
    if (version !== connectionVersion || !isOn()) return;
    elements.backendBanner.hidden = response.ok;
  } catch { if (version === connectionVersion && isOn()) elements.backendBanner.hidden = false; }
}
render(current);
refresh();
setInterval(refresh, 1200);
