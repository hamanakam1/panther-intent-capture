# Loaded-browser qualification

The unit suites are synthetic. They prove that the capture state machine, the
redaction rules, the storage contract and the delivery contract behave. They
cannot prove that the unpacked extension loads in a real browser, that a
consented capture reaches the local backend, or that a typed secret stays out
of the evidence.

`scripts/qualify_browser.mjs` does that, on a real Chromium.

## Running it

```bash
npm install
npx playwright-core install chromium
node scripts/qualify_browser.mjs --report browser-qualification.md
```

The script exits non-zero when a check fails. `--headed` runs the browser with
a visible window, which is useful when a check fails and the run needs to be
watched. The weekly workflow in `.github/workflows/browser-qualification.yml`
runs the same command and keeps the report as a build artifact.

## What the run does

1. Copies the extension into a temporary directory and adds **one** host
   permission for the synthetic page. An automated run cannot grant the
   `activeTab` permission that a toolbar click grants, so the test copy asks
   for the synthetic origin explicitly. Nothing else about the extension is
   changed, and the shipped extension is never modified.
2. Registers Panther's own on-demand native helper **inside the temporary
   browser profile**, so the real On/Off path is the one under test. No
   personal registration, helper file, or capture directory is touched.
3. Serves a synthetic page from a loopback port.
4. Loads the extension in a real Chromium with an isolated profile.
5. Turns Panther on from the popup, gives consent, captures the synthetic
   page, clicks a button, types a secret into a field, and stops.
6. Reads the local backend and checks what was stored.

## What it checks

| Check | What it establishes |
|---|---|
| Nothing listens on the backend port before the browser starts | The tool does not start a backend on its own. |
| The unpacked extension loads in a real browser | The manifest is valid and the service worker registers. |
| The browser derives the expected extension id | The helper is registered for the extension that actually loaded. |
| Opening the extension starts no backend | Loading Panther has no side effect. |
| Panther is off until it is explicitly turned on | The runtime starts nothing by itself. |
| Capture cannot start before Panther is on | Capture needs an explicit On. |
| Explicit On starts the owned backend | The native helper path works end to end. |
| Capture consent is explicit and stored | Consent is a deliberate act, not a default. |
| Capture can start once Panther is on and consent is given | The control flow is correct. |
| A consented capture starts on the chosen page | The chosen tab is the one that is captured. |
| The capture stops on request | Stop is honoured. |
| The capture is stored in the local backend | The upload path works against the real backend. |
| The chosen page's interactions were recorded | Evidence is captured from the real page. |
| A typed value never reaches the evidence | The privacy promise holds in a real browser. |
| An evidence draft is prepared without a model | The rules-only path produces a draft. |
| The export carries the intent bundle | The export is the versioned contract. |
| The export grants no execution authority | The export carries the authority fence. |
| The exported ticket states an expected result | The draft carries acceptance criteria. |
| A typed value never reaches the export | The privacy promise holds through the export. |
| The export keeps the stated goal | The user's own words survive the pipeline. |
| Explicit Off stops the owned backend | Off leaves nothing running. |

## What it does not prove

- Automatic ticket delivery to a destination, or that any destination accepts
  a ticket.
- Local model output, model quality, or latency.
- Screen-reader behaviour, browser zoom, or a keyboard-only session end to end.
- Other browsers, other websites, cross-origin navigation, or service-worker
  suspension.
- That a personal browser installation behaves like this isolated profile.

Those remain manual qualifications, recorded separately in the
`docs/*_TEST_RESULTS.md` reports.

## Notes

- The backend port is fixed at `127.0.0.1:7890` in the shipped extension. The
  qualification needs that port free; a backend already running there makes
  the run fail loudly rather than quietly.
- The status window that On opens is closed before the capture starts. Panther
  only captures the tab the browser reports as active, and the status window
  would otherwise be the focused window.
