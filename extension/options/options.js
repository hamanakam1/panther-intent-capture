import { BACKEND_ORIGIN } from "../shared/constants.js";
import { automationView, safeTicketURL } from "./automation-state.js";

const origin = location.protocol === "chrome-extension:" ? BACKEND_ORIGIN : location.origin;
const browserControlled = location.protocol === "chrome-extension:";
let browserPowerOn = !browserControlled;
const $ = id => document.getElementById(id);
let selected = null;
let recordings = [];
let activePreview = null;
let loading = false;
let requestVersion = 0;
let automation = null;
let automationStale = false;
let automationTimer = null;
let renderedDraftCount = 0;
let deliveryKind = "";
let automationRequest = 0;
let automationControlBusy = false;
const busyButtons = new WeakSet();

function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  if (browserControlled) {
    try {
      const state = await chrome.runtime.sendMessage({type: "extension.getPowerState"});
      browserPowerOn = state?.ok === true && state.power?.state === "on";
    } catch (_) { browserPowerOn = false; }
    syncDraftControls();
    if (!browserPowerOn) throw new Error("Panther is off. Turn Panther on from its browser popup, then refresh this page.");
  }
  const response = await fetch(origin + "/api/extension/" + path, {
    method, headers: { "Content-Type": "application/json", "X-Panther-Client": "review-v1" },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(path.startsWith("tickets/") ? 125000 : 30000)
  });
  const contentType = (response.headers && typeof response.headers.get === "function" ? response.headers.get("Content-Type") : "") || "";
  // Without a declared content type the response is JSON, which is what every
  // route but the plain-text script export returns.
  const isJson = !contentType || contentType.includes("application/json");
  const result = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(typeof result === "string" ? result : result.error || result.message || result.state || "Request failed");
    error.status = response.status; throw error;
  }
  return result;
}
function button(label, action, className = "") {
  const node = document.createElement("button");
  node.textContent = label; node.className = className;
  node.addEventListener("click", async () => {
    busyButtons.add(node); node.disabled = true;
    try { await action(); } catch (error) { message(error.message, true); }
    finally { busyButtons.delete(node); node.disabled = false; syncDraftControls(); }
  });
  return node;
}
function syncDraftControls() {
  const locked = !browserPowerOn || loading || (selected && automationView(automation, automationStale).locked);
  $("generate").disabled = Boolean(locked); $("generateAI").disabled = Boolean(locked);
  for (const node of $("tickets").querySelectorAll("input, textarea, button")) node.disabled = Boolean(locked || busyButtons.has(node));
}
function renderAutomation() {
  const view = automationView(automation, automationStale);
  $("automationPanel").hidden = view.hidden;
  $("automationStatus").textContent = view.text + (automation?.error ? " " + automation.error : "");
  const next = automation?.next_retry_at;
  $("automationMeta").textContent = [
    automation?.target_url ? "Destination: " + automation.target_url : "Destination not yet confirmed",
    automation?.use_ai ? "Local AI proposals" : "Observed-evidence proposals",
    "Attempts: " + (automation?.attempts || 0),
    Number.isFinite(next) && next > 0 ? "Next retry: " + new Date(next * 1000).toLocaleString() : "",
    "Drafts are frozen for the duration of automatic delivery; later edits do not update delivered tickets."
  ].filter(Boolean).join(" · ");
  $("retryAutomation").hidden = !view.retry;
  $("cancelAutomation").hidden = !view.cancel;
  $("retryAutomation").disabled = automationControlBusy;
  $("cancelAutomation").disabled = automationControlBusy;
  $("automationDeliveries").replaceChildren();
  for (const delivery of automation?.deliveries || []) {
    const verifiedAt = delivery.verified_at ?? delivery.receipt?.verified_at;
    const when = Number.isFinite(verifiedAt) ? new Date(verifiedAt * 1000).toLocaleString() : "time unavailable";
    const row = element("li", delivery.verified
      ? "Verified at " + when + " — this is historical delivery evidence, not a fresh check of the ticket's execution fence."
      : "Delivery state: " + (delivery.state || "unknown"));
    const href = safeTicketURL(delivery.ticket_url, automation.target_url);
    if (href) {
      const link = element("a", " Open ticket"); link.href = href; link.target = "_blank"; link.rel = "noopener"; row.append(link);
    }
    $("automationDeliveries").append(row);
  }
  syncDraftControls();
}
async function pollAutomation(id = selected?.id, version = requestVersion) {
  const poll = ++automationRequest;
  clearTimeout(automationTimer);
  if (!id || document.visibilityState === "hidden") return;
  try {
    const job = await api("automation/" + id);
    if (poll !== automationRequest || version !== requestVersion || selected?.id !== id) return;
    automation = job; automationStale = false; renderAutomation();
    if (job.ticket_count > 0 && renderedDraftCount === 0) {
      try {
        const drafts = await api("tickets/" + id);
        if (poll === automationRequest && version === requestVersion && selected?.id === id) renderTickets(drafts, id);
      } catch (_) { /* Job status is still useful while drafts become available. */ }
    }
  } catch (error) {
    if (poll !== automationRequest || version !== requestVersion || selected?.id !== id) return;
    automationStale = true; renderAutomation();
    $("automationStatus").textContent += " " + error.message;
  }
  if (poll === automationRequest && version === requestVersion && selected?.id === id && document.visibilityState !== "hidden" && automationView(automation, automationStale).poll) {
    automationTimer = setTimeout(() => pollAutomation(id, version), 2000);
  }
}
async function controlAutomation(action) {
  if (!selected || automationControlBusy) return;
  const id = selected.id, version = requestVersion;
  ++automationRequest; clearTimeout(automationTimer); automationControlBusy = true;
  $("retryAutomation").disabled = true; $("cancelAutomation").disabled = true;
  try {
    await api("automation/" + id, {action});
    if (version === requestVersion && selected?.id === id) await pollAutomation(id, version);
  } catch (error) {
    message(error.message, true);
    if (version === requestVersion && selected?.id === id) await pollAutomation(id, version);
  }
  finally {
    automationControlBusy = false;
    if (version === requestVersion && selected?.id === id) renderAutomation();
  }
}
function element(tag, text, className = "") {
  const node = document.createElement(tag);
  node.textContent = text; node.className = className;
  return node;
}
/** Describe one page-reported failure in a single line. */
function failureLine(diagnostic) {
  if (!diagnostic) return "";
  if (diagnostic.kind === "http_error") return `HTTP ${diagnostic.status || "?"}${diagnostic.source ? " " + diagnostic.source : ""}`;
  if (diagnostic.kind === "uncaught_exception") return `${diagnostic.message || "uncaught exception"}${diagnostic.source ? " (" + diagnostic.source + ")" : ""}`;
  if (diagnostic.kind === "unhandled_rejection") return diagnostic.message || "unhandled rejection";
  return `resource failed to load${diagnostic.source ? " " + diagnostic.source : ""}`;
}
/** Render the failures the page itself reported during this capture. */
async function renderDiagnostics(id, version) {
  $("diagnosticsPanel").hidden = true;
  $("diagnostics").replaceChildren();
  $("diagnosticNotice").textContent = "";
  try {
    const report = await api("recordings/" + id + "/diagnostics");
    if (version !== requestVersion || selected?.id !== id) return;
    if (!report.count) return;
    $("diagnosticsPanel").hidden = false;
    $("diagnosticNotice").textContent = report.interpretation;
    for (const failure of report.failures || []) {
      $("diagnostics").append(element("li", failure.summary || failureLine(failure)));
    }
  } catch (error) {
    if (version !== requestVersion || selected?.id !== id) return;
    $("diagnosticsPanel").hidden = false;
    $("diagnosticNotice").textContent = "Page-reported failures are unavailable: " + error.message;
  }
}
async function refresh() {
  try {
    const health = await api("health");
    $("backendStatus").textContent = health.status === "ok" ? "Local backend connected" : "Backend needs attention";
    $("backendDot").classList.toggle("ok", health.status === "ok");
    recordings = (await api("recordings")).recordings;
    renderLibrary();
    message(recordings.length ? "Captures are ready to review." : "No captures yet. Open the extension on a web page to start.");
  } catch (error) {
    $("backendStatus").textContent = "Local backend unavailable";
    $("backendDot").classList.remove("ok");
    message(error.message + " — start backend/start.sh, then refresh.", true);
  }
  try {
    const catalogue = await api("integrations");
    renderDestinations(catalogue.destinations || []);
  } catch (_) { $("dashboardStatus").textContent = "Delivery destination status unavailable"; }
}

/** Show every delivery destination and let one be chosen for manual delivery. */
function renderDestinations(list) {
  const previous = $("deliveryDestination").value;
  $("deliveryDestination").replaceChildren(...list.map((destination) => {
    const option = document.createElement("option");
    option.value = destination.kind;
    option.textContent = destination.available ? destination.label
      : destination.configured ? `${destination.label} (not reachable right now)` : `${destination.label} (not configured)`;
    option.disabled = !destination.configured;
    return option;
  }));
  const usable = list.filter((destination) => destination.configured);
  const chosen = usable.find((destination) => destination.kind === previous) || usable[0];
  $("deliveryDestination").value = chosen ? chosen.kind : "";
  $("deliveryDestination").hidden = list.length < 2;
  deliveryKind = chosen ? chosen.kind : "";
  const selected = list.find((destination) => destination.kind === deliveryKind);
  $("dashboardStatus").textContent = !selected ? "Delivery destination not configured · capture and JSON export still work"
    : selected.available ? `${selected.label} reachable · delivery verified when sent`
      : selected.configured ? `${selected.label} configured but not reachable · JSON export still works`
        : `${selected.label} is not configured · capture and JSON export still work`;
}
function renderLibrary() {
  $("count").textContent = recordings.length;
  $("recordings").replaceChildren();
  for (const capture of recordings) {
    const node = button(capture.title || capture.url || "Browser capture", () => openCapture(capture.id), "capture-choice");
    node.setAttribute("aria-current", String(selected?.id === capture.id));
    node.append(element("small", new Date(capture.start_time * 1000).toLocaleString() + " · " + capture.event_count + " events"));
    $("recordings").append(node);
  }
}
async function openCapture(id) {
  if (loading) return;
  const version = ++requestVersion;
  clearTimeout(automationTimer);
  const [capture, evidence] = await Promise.all([api("recordings/" + id), api("recordings/" + id + "/events")]);
  if (version !== requestVersion) return;
  selected = capture;
  automation = null; automationStale = false; renderedDraftCount = 0;
  $("tickets").replaceChildren(); renderAutomation();
  $("emptyReview").hidden = true; $("captureView").hidden = false;
  $("captureTitle").textContent = capture.title || "Browser capture";
  $("captureMeta").textContent = capture.url + " · " + capture.event_count + " events · " + (capture.duration_ms / 1000).toFixed(1) + " seconds";
  $("captureGoal").textContent = capture.goal ? "Your intent: " + capture.goal : "No intended outcome was supplied. Add the expected result to the draft.";
  $("events").replaceChildren();
  for (const event of evidence.events) {
    const failure = event.type === "diagnostic" ? event.diagnostic : null;
    $("events").append(element("li", [
      event.type, failure ? failureLine(failure) : event.target?.tag,
      failure ? "" : event.target?.label || event.target?.text || event.target?.ariaLabel || "",
      event.url || event.page?.url || "", event.target?.dataTab ? "tab: " + event.target.dataTab : "",
      event.target?.dataTicket ? "ticket: " + event.target.dataTicket : ""
    ].filter(Boolean).join(" · ")));
  }
  renderDiagnostics(id, version);
  $("screenshots").replaceChildren();
  $("screenshotPrivacyNotice").hidden = true;
  $("screenshotPrivacyNotice").textContent = "";
  $("screenshotsPanel").hidden = !capture.screenshot_count;
  if (capture.screenshot_count) {
    try {
      const shots = await api("recordings/" + id + "/screenshots");
      if (version !== requestVersion) return;
      if (shots.review_required === true || shots.redaction_status === "not_redacted") {
        $("screenshotPrivacyNotice").textContent = "Screenshot pixels are not redacted. Inspect each image before sharing or exporting this evidence.";
        $("screenshotPrivacyNotice").hidden = false;
      }
      for (const shot of shots.screenshots) {
        const img = document.createElement("img"); img.src = shot.dataUrl; img.alt = "Captured page evidence"; img.loading = "lazy";
        $("screenshots").append(img);
      }
    } catch (error) {
      if (version !== requestVersion) return;
      $("screenshots").append(element("p", "Screenshot evidence unavailable: " + error.message));
    }
  }
  $("generationStatus").textContent = "";
  try {
    const drafts = await api("tickets/" + id);
    if (version !== requestVersion) return;
    renderTickets(drafts, id);
  }
  catch (error) {
    if (version !== requestVersion) return;
    $("tickets").replaceChildren();
    $("generationStatus").textContent = error.message === "No drafts generated yet" ? "No drafts yet. Generate an evidence draft to start reviewing." : error.message;
  }
  renderLibrary();
  const url = new URL(location.href); url.searchParams.set("recording", id); history.replaceState(null, "", url);
  await pollAutomation(id, version);
}
async function generate(useAI) {
  if (!selected || loading || automationView(automation, automationStale).locked) return;
  loading = true;
  syncDraftControls();
  $("generationStatus").textContent = useAI ? "Generating drafts with local AI… This can take up to two minutes." : "Preparing an evidence draft from captured interactions…";
  message("Draft generation in progress.");
  try {
    const data = await api("tickets/" + selected.id, {use_ai: useAI});
    renderTickets(data);
    message(data.tickets.length + " draft(s) ready for review. This generation did not submit new tickets.");
  } catch (error) {
    $("generationStatus").textContent = "Generation failed: " + error.message + " Your capture is saved; you can retry.";
    message(error.message, true);
  } finally { loading = false; syncDraftControls(); }
}
function renderTickets(data, recordingId = selected.id) {
  renderedDraftCount = data.tickets.length;
  $("tickets").replaceChildren();
  $("generationStatus").textContent = data.tickets.length + " draft(s) · " +
    (data.mode === "ai" ? "Local AI suggestions — verify against evidence" : "Observed steps only — intended outcome needs review");
  for (const ticket of data.tickets) {
    const card = element("article", "", "ticket");
    card.append(element("span", data.mode === "ai" ? "AI PROPOSAL · UNVERIFIED" : "EVIDENCE DRAFT · REVIEW REQUIRED", "badge"));
    const fields = {};
    for (const [key, label, multiline] of [["title", "Ticket title", false], ["description", "Problem or improvement", true], ["acceptance_criteria", "Expected result / acceptance criteria (one per line)", true]]) {
      const id = "draft-" + ticket.id + "-" + key;
      const fieldLabel = element("label", label); fieldLabel.htmlFor = id;
      const input = document.createElement(multiline ? "textarea" : "input");
      input.id = id; input.maxLength = key === "title" ? 200 : key === "description" ? 2000 : 5000;
      input.value = key === "acceptance_criteria" ? (ticket[key] || []).join("\n") : ticket[key] || "";
      fields[key] = input; card.append(fieldLabel, input);
    }
    card.append(element("pre", "Observed steps:\n" + (ticket.steps_to_reproduce || []).map((s,i) => (i + 1) + ". " + s).join("\n")));
    if ((ticket.diagnostics || []).length) {
      card.append(element("p", "Page-reported failures (observations, not verified defects): "
        + ticket.diagnostics.map(failureLine).join("; "), "muted"));
    }
    if ((ticket.friction || []).length) {
      card.append(element("p", "Possible friction (hypotheses, not confirmed defects): "
        + ticket.friction.map(finding => finding.title).join("; "), "muted"));
    }
    card.append(element("p", ticket.evidence || "", "muted"));
    const actions = element("div", "", "actions");
    const patch = () => ({title: fields.title.value.trim(), description: fields.description.value.trim(), acceptance_criteria: fields.acceptance_criteria.value.split("\n").map(x => x.trim()).filter(Boolean)});
    actions.append(button("Save draft edits", async () => {
      await api("tickets/" + recordingId + "/review", {ticket_id: ticket.id, patch: patch()});
      message("Draft edits saved locally.");
    }));
    actions.append(button("Preview ticket delivery", async () => {
      const body = {ticket_id: ticket.id, patch: patch()};
      await api("tickets/" + recordingId + "/review", body);
      const preview = await api("integrations/" + encodeURIComponent(deliveryKind) + "/preview/" + recordingId, body);
      activePreview = {id: recordingId, body, preview};
      const summary = $("previewSummary");
      summary.replaceChildren(element("h3", preview.payload.title), element("p", body.patch.description));
      summary.append(element("h3", "Expected result"));
      const criteria = element("ul", "");
      for (const value of body.patch.acceptance_criteria) criteria.append(element("li", value));
      summary.append(criteria);
      if (!body.patch.acceptance_criteria.length) summary.append(element("p", "No acceptance criteria supplied. Consider defining how this change will be verified.", "muted"));
      summary.append(element("h3", "Observed steps"));
      const steps = element("ol", "");
      for (const value of (ticket.steps_to_reproduce || []).slice(0, 10)) steps.append(element("li", value));
      summary.append(steps);
      $("previewBody").textContent = JSON.stringify(preview.payload, null, 2);
      $("previewWarnings").textContent = (preview.warnings || []).join(" ");
      $("deliveryStatus").textContent = "";
      $("confirmSend").disabled = false;
      $("previewDialog").showModal();
    }, "primary"));
    card.append(actions);
    $("tickets").append(card);
  }
  syncDraftControls();
}
$("refresh").addEventListener("click", refresh);
$("generate").addEventListener("click", () => generate(false));
$("generateAI").addEventListener("click", () => generate(true));
$("retryAutomation").addEventListener("click", () => controlAutomation("retry"));
$("cancelAutomation").addEventListener("click", () => controlAutomation("cancel"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { ++automationRequest; clearTimeout(automationTimer); }
  else if (selected) pollAutomation();
});
$("cancelSend").addEventListener("click", () => $("previewDialog").close());
$("confirmSend").addEventListener("click", async () => {
  if (!activePreview) return;
  $("confirmSend").disabled = true;
  $("deliveryStatus").classList.remove("error");
  $("deliveryStatus").textContent = "Sending and verifying the dashboard ticket…";
  try {
    const {id, body, preview} = activePreview;
    const result = await api("integrations/" + encodeURIComponent(deliveryKind) + "/submit/" + id, {...body, confirmed: true, payload_hash: preview.payload_hash});
    if (result.verified) {
      const verifiedAt = result.receipt?.verified_at;
      const when = Number.isFinite(verifiedAt) ? new Date(verifiedAt * 1000).toLocaleString() : "the recorded delivery time";
      $("deliveryStatus").textContent = result.previously_verified
        ? "Previously verified at the destination: " + result.ticket_key + " at " + when + ". No duplicate sent; current ticket state has not been rechecked."
        : "Verified at the destination: " + result.ticket_key + " at " + when + ". The ticket had its no-auto review fence at verification.";
    } else {
      $("deliveryStatus").textContent = "Submission state: " + result.state + ". Verification is still pending; retry uses the same capture identity.";
    }
    if (result.verified && result.ticket_url) {
      const link = element("a", " Open ticket"); link.href = result.ticket_url; link.target = "_blank"; link.rel = "noopener"; $("deliveryStatus").append(link);
    }
  } catch (error) {
    $("deliveryStatus").textContent = error.message + " — Retry preserves the same ticket identity.";
    $("deliveryStatus").classList.add("error");
  } finally { $("confirmSend").disabled = false; }
});
$("deleteCapture").addEventListener("click", async () => {
  if (!selected || !confirm("Delete this capture and its local evidence? Tickets already sent to other systems remain there.")) return;
  try {
    await api("recordings/" + selected.id, undefined, "DELETE");
    ++requestVersion; clearTimeout(automationTimer); selected = null; automation = null;
    $("captureView").hidden = true; $("emptyReview").hidden = false; await refresh();
  } catch (error) { message(error.message, true); }
});
function download(name, content, type) {
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
$("exportReplay").addEventListener("click", async () => {
  if (!selected) return;
  try {
    const plan = await api("recordings/" + selected.id + "/replay");
    download("panther-replay-" + selected.id + ".json", JSON.stringify(plan, null, 2), "application/json");
    message("Replay plan exported. It describes the recorded path only; no typed value was ever captured.");
  } catch (error) { message(error.message, true); }
});
$("exportReplayScript").addEventListener("click", async () => {
  if (!selected) return;
  try {
    const plan = await api("recordings/" + selected.id + "/replay?format=playwright");
    download("panther-replay-" + selected.id + ".py", plan, "text/plain");
    message("Replay script exported. It is a proposal to review; Panther never runs it.");
  } catch (error) { message(error.message, true); }
});
$("export").addEventListener("click", async () => {
  if (!selected) return;
  try {
    const bundle = await api("export/" + selected.id);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = "panther-" + selected.id + ".json"; link.click(); URL.revokeObjectURL(url);
    message("Draft bundle exported. Save any draft edits before exporting.");
  } catch (error) { message(error.message, true); }
});
await refresh();
const initial = new URL(location.href).searchParams.get("recording");
if (initial && recordings.some(r => r.id === initial)) await openCapture(initial);
