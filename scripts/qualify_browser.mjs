#!/usr/bin/env node
/**
 * Loaded-browser qualification for Panther Intent Capture.
 *
 * The synthetic suites cannot show that the unpacked extension loads in a real
 * browser, that a consented capture reaches the local backend, or that a typed
 * secret stays out of the evidence. This script does, on a real Chromium.
 *
 * What it does, in order:
 *
 *   1. copies the extension into a temporary directory and adds one host
 *      permission for the synthetic page. An automated run cannot grant the
 *      `activeTab` permission that a toolbar click grants, so the test copy
 *      asks for the synthetic origin explicitly. Nothing else is changed.
 *   2. registers Panther's own on-demand native helper inside the temporary
 *      browser profile, so the real On/Off path is the one under test.
 *   3. serves a synthetic page from a loopback port.
 *   4. loads the extension in a real Chromium with an isolated profile.
 *   5. turns Panther on from the popup, gives consent, captures the synthetic
 *      page, clicks a button, types a secret into a field, and stops.
 *   6. reads the local backend and checks what was stored.
 *
 * What it does not prove: automatic ticket delivery, local model output,
 * screen-reader behaviour, other browsers, or any other website.
 *
 * Usage:
 *
 *     npm install
 *     npx playwright-core install chromium
 *     node scripts/qualify_browser.mjs [--report path.md] [--headed]
 *
 * The script exits non-zero when a check fails.
 */

import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND_ORIGIN = "http://127.0.0.1:7890";
const SECRET = "promo-secret-9f2b41c7";
const GOAL = "Applying a promo code should not discard the entered code";

const args = process.argv.slice(2);
const reportPath = args.includes("--report") ? args[args.indexOf("--report") + 1] : "";
const headed = args.includes("--headed");

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
  return Boolean(ok);
}

/** The id Chrome derives from an unpacked extension's absolute path. */
function extensionIdFor(absolutePath) {
  const digest = createHash("sha256").update(absolutePath).digest("hex").slice(0, 32);
  return [...digest].map((character) => String.fromCharCode("a".charCodeAt(0) + parseInt(character, 16))).join("");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, { timeout = 30000, interval = 250, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function backendListening() {
  try {
    const response = await fetch(`${BACKEND_ORIGIN}/api/extension/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function backendJson(route) {
  const response = await fetch(`${BACKEND_ORIGIN}/api/extension/${route}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${route} answered ${response.status}`);
  return response.json();
}

const SYNTHETIC_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Checkout - orders.example.test</title></head>
<body>
  <h1>Synthetic checkout</h1>
  <p id="state">Ready</p>
  <button id="apply" type="button">Apply promo code</button>
  <input id="promo" type="password" aria-label="Promo code">
  <a id="next" href="/next">Next step</a>
  <script>document.getElementById("apply").addEventListener("click", () => { document.getElementById("state").textContent = "Applied"; });</script>
</body></html>`;

function startSyntheticPage() {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(SYNTHETIC_PAGE);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function prepareExtensionCopy(port) {
  const directory = path.join(await mkdtemp(path.join(tmpdir(), "panther-qualify-")), "extension");
  await cp(path.join(ROOT, "extension"), directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const pageOrigin = `http://127.0.0.1:${port}/*`;
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), pageOrigin])];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  // Chrome derives the id from the resolved path, so a temporary directory
  // behind a symbolic link has to be resolved the same way.
  const resolved = await realpath(directory);
  return { directory: resolved, id: extensionIdFor(resolved) };
}

async function main() {
  if (await backendListening()) {
    console.error(`A backend is already listening on ${BACKEND_ORIGIN}. Panther's backend port is fixed, so stop that backend before qualifying.`);
    return 2;
  }
  const workspace = await mkdtemp(path.join(tmpdir(), "panther-qualify-"));
  const profile = path.join(workspace, "profile");
  const dataDir = path.join(workspace, "data");
  await mkdir(profile, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const { server, port } = await startSyntheticPage();
  const syntheticUrl = `http://127.0.0.1:${port}/checkout`;
  const extensionCopy = await prepareExtensionCopy(port);
  let context = null;
  let exitCode = 0;

  try {
    console.log(`synthetic page   ${syntheticUrl}`);
    console.log(`extension copy   ${extensionCopy.directory}`);
    console.log(`extension id     ${extensionCopy.id}`);
    console.log(`profile          ${profile}\n`);

    check("nothing is listening on the backend port before the browser starts", !(await backendListening()));

    // Panther's own helper, registered inside the throwaway profile.
    await execFileAsync("python3", [
      path.join(ROOT, "scripts", "install_browser_helper.py"),
      "--browser", "chromium",
      "--extension-id", extensionCopy.id,
      "--data-dir", dataDir,
      "--user-data-dir", profile,
    ], { cwd: ROOT });

    context = await chromium.launchPersistentContext(profile, {
      // The full Chromium build, not the headless shell: only the full build
      // can load an unpacked extension.
      channel: "chromium",
      headless: !headed,
      args: [
        `--disable-extensions-except=${extensionCopy.directory}`,
        `--load-extension=${extensionCopy.directory}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });

    const worker = await waitFor(async () => {
      const [first] = context.serviceWorkers();
      if (first) return first;
      return context.waitForEvent("serviceworker", { timeout: 2000 }).catch(() => null);
    }, { timeout: 30000, label: "the extension service worker" });

    check("the unpacked extension loads in a real browser", Boolean(worker), worker.url());
    check("the browser derives the expected extension id", new URL(worker.url()).host === extensionCopy.id, new URL(worker.url()).host);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionCopy.id}/popup/popup.html`);
    await popup.waitForSelector("#turnOnBtn", { timeout: 15000 });

    check("opening the extension starts no backend", !(await backendListening()));
    check("Panther is off until it is explicitly turned on", (await popup.textContent("#powerStatus")).includes("off"));
    check("capture cannot start before Panther is on", await popup.isDisabled("#recordBtn"));

    // Explicit On, through the popup's own control.
    await popup.click("#turnOnBtn");
    let powerError = "";
    try {
      await waitFor(async () => (await popup.textContent("#powerStatus")).toLowerCase().includes("on"), { timeout: 45000, label: "Panther to turn on" });
    } catch (error) {
      powerError = (await popup.textContent("#powerError")) || error.message;
      const setup = await popup.isVisible("#setupNeeded");
      check("explicit On starts the owned backend", false, `${powerError}${setup ? " (the popup reports that the helper is not registered)" : ""}`);
      throw new Error(`Panther did not turn on: ${powerError}`);
    }
    const backendUp = await waitFor(async () => (await backendListening()) || false, { timeout: 15000, label: "the owned backend to answer" })
      .catch(async () => false);
    check("explicit On starts the owned backend", backendUp,
      backendUp ? "" : `the popup reported "${(await popup.textContent("#powerStatus")).trim()}" and ${(await popup.textContent("#powerError")).trim() || "no error"}`);

    // Consent, through the popup's own control.
    await popup.waitForFunction(() => !document.getElementById("consent").disabled, null, { timeout: 15000 });
    await popup.click("#consent");
    await popup.fill("#goal", GOAL);
    await waitFor(async () => popup.evaluate(async () => {
      const stored = await chrome.storage.local.get("extension.local.state");
      return stored["extension.local.state"]?.enabled === true;
    }), { timeout: 15000, label: "capture consent to be stored" });
    check("capture consent is explicit and stored", true);
    check("capture can start once Panther is on and consent is given", !(await popup.isDisabled("#recordBtn")));

    // The status window that On opens would be the focused window, and Panther
    // only captures the tab the browser reports as active. Close it: closing
    // the status window hides the view and does not stop Panther.
    await popup.evaluate(async () => {
      for (const window of await chrome.windows.getAll({})) {
        const tabs = await chrome.tabs.query({ windowId: window.id });
        if (tabs.some((tab) => String(tab.url || "").includes("/monitor/monitor.html"))) {
          await chrome.windows.remove(window.id).catch(() => {});
        }
      }
    });

    // The synthetic page, then the capture.
    const page = await context.newPage();
    await page.goto(syntheticUrl);
    await page.bringToFront();
    const tabId = await popup.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return tab?.id ?? null;
    }, syntheticUrl);

    // The capture is admitted through the popup's own runtime command path,
    // with the chosen page in front: the extension only captures the tab the
    // browser reports as active.
    const started = await popup.evaluate(async ({ id, goal }) => chrome.runtime.sendMessage({
      type: "extension.startRecording", tabId: id, consent: true, goal,
    }), { id: tabId, goal: GOAL });
    check("a consented capture starts on the chosen page", started?.ok === true, started?.error || `tab ${tabId}`);
    if (started?.ok !== true) throw new Error(`the capture did not start: ${started?.error || "unknown reason"}`);

    await page.click("#apply");
    await page.fill("#promo", SECRET);
    await page.keyboard.type("x");
    await new Promise((resolve) => setTimeout(resolve, 1200));

    await popup.click("#stopBtn");
    await waitFor(async () => !(await popup.textContent("#status")).includes("Capturing"), { timeout: 20000, label: "the capture to stop" });
    check("the capture stops on request", true);

    const recordings = await waitFor(async () => {
      const listed = await backendJson("recordings");
      return listed.recordings?.length ? listed.recordings : null;
    }, { timeout: 30000, label: "the capture to reach the backend" });

    const capture = recordings[0];
    check("the capture is stored in the local backend", Boolean(capture?.id), `${capture?.event_count ?? 0} events`);

    const events = await backendJson(`recordings/${capture.id}/events`);
    const serialized = JSON.stringify(events);
    check("the chosen page's interactions were recorded", serialized.includes("Apply promo code"), "the clicked button label is present");
    check("a typed value never reaches the evidence", !serialized.includes(SECRET));

    const draft = await backendJson(`tickets/${capture.id}`);
    const exportBundle = await backendJson(`export/${capture.id}`);
    const exported = JSON.stringify(exportBundle);
    check("an evidence draft is prepared without a model", (draft?.tickets?.length ?? 0) > 0, `${draft?.tickets?.length ?? 0} draft(s)`);
    check("the export carries the intent bundle", exportBundle?.schema_version === "1.1", `schema version ${exportBundle?.schema_version}`);
    check("the export grants no execution authority", exportBundle?.authority?.execution_authorized === false);
    check("the exported ticket states an expected result", JSON.stringify(exportBundle?.tickets || []).toLowerCase().includes("accept"), "acceptance criteria are present");
    check("the typed value never reaches the export", !exported.includes(SECRET));
    check("the export keeps the stated goal", exported.includes("promo code"));

    // Explicit Off, through the popup's own control.
    await popup.click("#turnOffBtn").catch(async () => {
      await popup.evaluate(async () => chrome.runtime.sendMessage({ type: "extension.turnOff" }));
    });
    await waitFor(async () => !(await backendListening()), { timeout: 30000, label: "the owned backend to stop" });
    check("explicit Off stops the owned backend", true);
  } catch (error) {
    check("the qualification run completed", false, error.message);
    exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }

  const failed = checks.filter((entry) => !entry.ok);
  const summary = `${checks.length - failed.length}/${checks.length} checks passed`;
  console.log(`\n${summary}`);

  if (reportPath) {
    const report = [
      "# Loaded-browser qualification",
      "",
      `Run on a real Chromium through \`scripts/qualify_browser.mjs\`. ${summary}.`,
      "",
      "| Check | Result | Detail |",
      "|---|---|---|",
      ...checks.map((entry) => `| ${entry.name} | ${entry.ok ? "pass" : "fail"} | ${entry.detail.replace(/\|/g, "\\|")} |`),
      "",
      "The test copy of the extension adds one host permission for the synthetic page, because an",
      "automated run cannot grant the `activeTab` permission a toolbar click grants. Nothing else",
      "about the shipped extension is changed.",
      "",
    ].join("\n");
    await writeFile(reportPath, report, "utf8");
    console.log(`wrote ${reportPath}`);
  }

  if (failed.length) exitCode = 1;
  return exitCode;
}

if (!existsSync(path.join(ROOT, "node_modules", "playwright-core"))) {
  console.error("playwright-core is not installed. Run: npm install && npx playwright-core install chromium");
  process.exit(2);
}

process.exit(await main());
