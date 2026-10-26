/* Classic script: executeScript files cannot contain module imports. */
(() => {
  if (globalThis.__pantherCaptureInstalled) return;
  globalThis.__pantherCaptureInstalled = true;
  let sessionId = null;
  let diagnosticNonce = "";
  let captureStartMs = 0;
  let lastUrl = "";
  let routeTimer = null;
  let statusTimer = null;
  let panel = null;
  let statusText, detailsText, stopButton, reviewButton;

  // Page-failure channels. These mirror the extension's shared allowlist and
  // the backend's copy; a new kind needs all three plus a parity update.
  const DIAGNOSTIC_KINDS = new Set(["uncaught_exception", "unhandled_rejection", "http_error", "resource_error"]);
  const RESOURCE_TAGS = new Set(["img", "script", "link", "iframe", "source", "video", "audio", "embed", "object"]);
  const MAX_DIAGNOSTICS = 50;
  let diagnosticsReported = 0;
  let diagnosticsStarted = false;

  function safeUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (!/^https?:$/.test(url.protocol)) return "";
      url.username = ""; url.password = ""; url.search = "";
      if (!/^#\/?[a-z][a-z0-9_/-]{0,100}$/i.test(url.hash) || /secret|token|key|pass|cred|auth|cookie|session/i.test(url.hash)) url.hash = "";
      url.pathname = url.pathname.split("/").map((part, i, parts) =>
        /secret|token|key|pass|cred|auth|cookie|session/i.test(decodeURIComponent(parts[i - 1] || "")) || part.length > 48 ? "REDACTED" : part).join("/");
      return url.href;
    } catch { return ""; }
  }

  // Controls Panther recognises, and the wider set it still describes.
  const CONTROLS = "button,a,input,select,textarea,[role=button],[role=tab],[data-tab],[data-ticket]";
  const SEMANTIC = CONTROLS + ",form";

  /**
   * Does an element present itself as interactive?
   *
   * A click that lands on something the page never marked as a control is
   * worth recording when the element still looks interactive to the person:
   * it declares a role, it is focusable, or it is styled as a pointer. An
   * ordinary click on empty space is not evidence of anything and is left
   * out.
   */
  function presentsAsInteractive(element) {
    if (!element || typeof element.getAttribute !== "function") return false;
    try {
      if (element.getAttribute("role")) return true;
      if (typeof element.hasAttribute === "function" && element.hasAttribute("tabindex")) return true;
      if (typeof getComputedStyle === "function") return getComputedStyle(element).cursor === "pointer";
    } catch { /* A detached or replaced element cannot be inspected. */ }
    return false;
  }

  function send(type, target = null) {
    if (!sessionId) return;
    const control = target?.closest?.(CONTROLS);
    const semantic = control || target?.closest?.("form");
    if (target && !semantic) {
      // The click landed on something that is not a control. Record it only
      // when the element presents itself as interactive.
      if (type === "click" && presentsAsInteractive(target)) {
        const element = target;
        chrome.runtime.sendMessage({ type: "page.interaction", sessionId, payload: {
          type: "click", ts: Date.now(), url: safeUrl(location.href),
          target: {
            tag: String(element.tagName || "").toLowerCase().slice(0, 40),
            role: element.getAttribute("role") || "",
            id: element.id || "",
            inert: true
          }
        } }).catch(() => { /* The background may have gone away; the page keeps working. */ });
      }
      return;
    }
    const payload = { type, ts: Date.now(), url: safeUrl(location.href) };
    if (semantic) {
      const tag = semantic.tagName.toLowerCase();
      // Never inspect input values, typed keys, page body text, or editable text.
      const hasEditableContent = semantic.isContentEditable || semantic.querySelector("input,textarea,select,[contenteditable],[role=textbox]");
      const label = ["button", "a"].includes(tag) && !hasEditableContent ?
        (semantic.getAttribute("aria-label") || semantic.textContent || "").trim().slice(0, 120) : "";
      payload.target = {
        tag, role: semantic.getAttribute("role") || "", id: semantic.id || "",
        type: semantic.getAttribute("type") || "", label,
        href: tag === "a" ? safeUrl(semantic.href) : "",
        dataTab: semantic.getAttribute("data-tab") || "",
        dataTicket: semantic.getAttribute("data-ticket") || ""
      };
      // The click landed on something the page never marked as a control.
      if (!control && type === "click" && presentsAsInteractive(target)) payload.target.inert = true;
    }
    chrome.runtime.sendMessage({ type: "page.interaction", sessionId, payload }).then((reply) => {
      if (!reply?.ok) {
        stopListening();
        if (detailsText && reply?.error) detailsText.textContent = reply.error;
      }
      if (reply?.eventCount !== undefined && detailsText) detailsText.textContent = `${reply.eventCount} events · this tab only${reply.warning ? ` · ${reply.warning}` : ""}`;
    }).catch(() => stopListening());
  }

  function routeChanged() {
    if (sessionId && location.href !== lastUrl) {
      lastUrl = location.href;
      send("navigation");
    }
  }

  /**
   * Report a page failure the page itself disclosed.
   *
   * These are observations, not proof that a defect exists. Nothing here reads
   * page body text, input values or typed keys: a failure carries a bounded
   * message, a sanitized URL and, for HTTP failures, a status code.
   */
  function reportDiagnostic(detail, startedAt) {
    if (!sessionId || !detail || typeof detail !== "object") return;
    if (diagnosticsReported >= MAX_DIAGNOSTICS) return;
    const kind = typeof detail.kind === "string" ? detail.kind : "";
    if (!DIAGNOSTIC_KINDS.has(kind)) return;
    const diagnostic = { kind };
    if (typeof detail.message === "string") diagnostic.message = detail.message.slice(0, 300);
    if (typeof detail.source === "string") diagnostic.source = detail.source.slice(0, 2000);
    if (Number.isInteger(detail.status)) diagnostic.status = detail.status;
    if (Number.isInteger(detail.line)) diagnostic.line = detail.line;
    if (Number.isInteger(detail.column)) diagnostic.column = detail.column;
    diagnosticsReported++;
    chrome.runtime.sendMessage({
      type: "page.diagnostic",
      sessionId,
      payload: {
        type: "diagnostic",
        ts: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now(),
        url: safeUrl(location.href),
        diagnostic
      }
    }).catch(() => { /* The background may have gone away; the page keeps working. */ });
  }

  /**
   * Listen for the failures this page can disclose without being modified.
   *
   * The page's own uncaught exceptions and unhandled rejections arrive through
   * a main-world relay installed by the background, because an isolated world
   * cannot observe them. Failed subresources and HTTP error responses are
   * observed here directly.
   */
  function startDiagnostics() {
    // Listeners live for the life of this document. A second capture on the
    // same page reuses them instead of reporting each failure twice.
    if (diagnosticsStarted) return;
    diagnosticsStarted = true;
    // A subresource that failed to load reports on its own element.
    document.addEventListener("error", (event) => {
      const target = event.target;
      if (!target || target === window || typeof target.tagName !== "string") return;
      const tag = target.tagName.toLowerCase();
      if (!RESOURCE_TAGS.has(tag)) return;
      reportDiagnostic({
        kind: "resource_error",
        message: `A ${tag} resource failed to load`,
        source: typeof target.src === "string" ? target.src : typeof target.href === "string" ? target.href : ""
      });
    }, true);

    // The main-world relay reports the page's own uncaught failures. The
    // session nonce separates Panther's relay from any other listener.
    document.addEventListener("panther-diagnostic", (event) => {
      const detail = event.detail;
      if (!detail || typeof detail !== "object") return;
      if (detail.nonce !== diagnosticNonce || !diagnosticNonce) return;
      reportDiagnostic({
        kind: detail.kind,
        message: detail.message,
        source: detail.source,
        status: detail.status,
        line: detail.line,
        column: detail.column
      });
    });

    // Requests the page made that returned an HTTP error status. A response
    // without a readable status is not reported: an opaque cross-origin
    // response and a cached response are not failures.
    //
    // The buffered entries include failures that happened before the capture
    // began. Those are outside the consented window, so they are left out,
    // and the ones that are kept carry their own real time so the recorded
    // timeline stays truthful.
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const status = entry.responseStatus;
          if (!Number.isInteger(status) || status < 400 || status > 599) continue;
          const startedAt = performance.timeOrigin + entry.startTime;
          if (!Number.isFinite(startedAt)) continue;
          if (captureStartMs && startedAt + 500 < captureStartMs) continue;
          reportDiagnostic({
            kind: "http_error",
            message: `A request returned HTTP ${status}`,
            source: entry.name,
            status
          }, startedAt);
        }
      });
      observer.observe({ type: "resource", buffered: true });
    } catch { /* Resource timing is unavailable in this browser. */ }
  }

  function stopListening() {
    sessionId = null;
    diagnosticNonce = "";
    clearInterval(routeTimer);
    routeTimer = null;
  }

  function hidePanel() {
    panel?.remove();
    panel = null;
    clearInterval(statusTimer);
    statusTimer = null;
  }

  function renderStatus(state) {
    if (!panel || !state?.ok) return;
    const labels = { recording: "Capturing", saving: "Saving recording…", pending: "Upload needs retry", generating: "Generating drafts…", ready: "Drafts ready", error: "Generation needs retry", idle: "Idle" };
    const job = state.result?.automation;
    const deliveryLabels = { queued: "Delivery queued", generating: "Generating tickets…", delivering: "Delivering tickets…", retry_wait: "Delivery retry scheduled", delivered: "Tickets delivered", blocked: "Delivery blocked", cancelled: "Delivery cancelled" };
    statusText.textContent = `Panther · ${state.result?.automationPolicy ? (state.result.error ? "Delivery needs attention" : deliveryLabels[job?.status] || "Checking delivery…") : labels[state.status] || state.status}`;
    const details = state.session?.error || state.result?.error || job?.error ||
      (state.result?.automationPolicy ? `${job?.delivered_count || 0}/${job?.ticket_count || 0} historical delivery receipts · review-only backlog; no work execution` :
      state.status === "ready" ? `${state.result.ticketCount} reviewable draft${state.result.ticketCount === 1 ? "" : "s"} · ${state.result.eventCount} events` :
        `${state.session?.eventCount ?? state.result?.eventCount ?? 0} events · this tab only`);
    const warning = state.session?.warning || state.result?.warning;
    detailsText.textContent = `${details}${warning ? ` · ${warning}` : ""}`;
    stopButton.hidden = state.status !== "recording";
    stopButton.textContent = state.session?.automation && !state.session.automationWithdrawn ? "Stop & deliver" : "Stop & generate";
    stopButton.disabled = false;
    reviewButton.hidden = !state.result?.id;
    if (state.status !== "recording") stopListening();
  }

  async function refreshStatus() {
    try { renderStatus(await chrome.runtime.sendMessage({ type: "page.getStatus" })); }
    catch { if (statusText) statusText.textContent = "Panther · reopen extension to check status"; }
  }

  function showPanel() {
    hidePanel();
    panel = document.createElement("div");
    panel.id = "panther-intent-capture-controls";
    panel.style.cssText = "all:initial!important;position:fixed!important;bottom:18px!important;right:18px!important;z-index:2147483647!important;display:block!important;";
    const shadow = panel.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = ".box{box-sizing:border-box;width:270px;padding:14px;background:#111827;color:#f9fafb;border:1px solid #475569;border-radius:12px;box-shadow:0 8px 30px #0005;font:13px/1.4 system-ui}strong{display:block;font-size:14px}p{margin:7px 0 10px;color:#cbd5e1;overflow-wrap:anywhere}nav{display:flex;gap:6px;flex-wrap:wrap}button{font:600 12px system-ui;padding:7px 9px;border-radius:6px;border:1px solid #64748b;background:#334155;color:white;cursor:pointer}button[hidden]{display:none}button:disabled{opacity:.5}.stop{background:#b91c1c;border-color:#f87171}.hide{margin-left:auto}";
    const box = document.createElement("section");
    box.className = "box";
    box.setAttribute("aria-label", "Panther capture controls");
    statusText = document.createElement("strong");
    statusText.setAttribute("role", "status");
    statusText.textContent = "Panther · Capturing";
    detailsText = document.createElement("p");
    detailsText.textContent = "0 events · this tab only";
    const controls = document.createElement("nav");
    stopButton = document.createElement("button");
    stopButton.type = "button"; stopButton.className = "stop"; stopButton.textContent = "Stop & generate";
    stopButton.addEventListener("click", async () => {
      stopButton.disabled = true;
      statusText.textContent = "Panther · Saving recording…";
      try {
        const response = await chrome.runtime.sendMessage({ type: "page.stop", sessionId });
        if (response?.status) renderStatus({ ...response, ok: true });
        else { statusText.textContent = "Panther · Stop needs attention"; detailsText.textContent = response?.error || "Check the extension for capture status."; }
      } catch { statusText.textContent = "Panther · Check the extension for upload status"; }
    });
    reviewButton = document.createElement("button");
    reviewButton.type = "button"; reviewButton.textContent = "Review drafts"; reviewButton.hidden = true;
    reviewButton.addEventListener("click", () => { chrome.runtime.sendMessage({ type: "page.openReview" }).catch(() => {}); });
    const hide = document.createElement("button");
    hide.type = "button"; hide.className = "hide"; hide.textContent = "Hide";
    hide.title = "Hide this panel; capture continues. Use the extension icon to stop.";
    hide.addEventListener("click", hidePanel);
    controls.append(stopButton, reviewButton, hide);
    box.append(statusText, detailsText, controls);
    shadow.append(style, box);
    document.documentElement.appendChild(panel);
    statusTimer = setInterval(refreshStatus, 1000);
  }

  function enable(id, automationEnabled = false, nonce = "", startedAt = 0) {
    if (sessionId === id) return;
    stopListening();
    sessionId = id;
    diagnosticNonce = typeof nonce === "string" ? nonce : "";
    captureStartMs = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0;
    diagnosticsReported = 0;
    lastUrl = location.href;
    showPanel();
    stopButton.textContent = automationEnabled ? "Stop & deliver" : "Stop & generate";
    // pushState is not observable from an isolated content world. Poll only
    // during active capture to include SPA routers and dashboard hash routes.
    routeTimer = setInterval(routeChanged, 500);
    startDiagnostics();
    send("navigation");
  }

  for (const type of ["click", "change", "submit"]) {
    document.addEventListener(type, (event) => {
      if (event.isTrusted && !event.composedPath().includes(panel)) send(type, event.target);
    }, true);
  }
  window.addEventListener("hashchange", routeChanged);
  window.addEventListener("popstate", routeChanged);
  // Every event is sent immediately, with no unload-time batch or Blob message.
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === "extension.captureStart") {
      enable(message.sessionId, message.automationEnabled === true, message.diagnosticNonce, message.captureStartMs);
      reply({ ok: true });
    } else if (message.type === "extension.captureStop") {
      stopListening();
      refreshStatus();
      reply({ ok: true });
    }
  });
})();
