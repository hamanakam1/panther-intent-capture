# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- A redaction parity test that runs one corpus through the extension and the backend and requires the same result, so the two implementations cannot drift apart.
- A markup-integrity regression that keeps every extension page a single document whose element ids are unique.

### Changed
- Nothing yet

### Deprecated
- Nothing yet

### Removed
- Nothing yet

### Fixed
- The status window no longer carries a second copy of its understanding, activity, evidence and control sections. The duplicate sat after the closing `</html>` tag, so the browser folded it back into the body: the window rendered those sections twice, and the script only ever updated the first copy of each control.
- The backend now redacts session identifiers in URL path segments and fragments, matching the extension. A client posting directly to the backend could previously store a session identifier that the extension would have removed.
- The backend now stamps every capture event with a timestamp when the client omits one, instead of dropping the event's timing and leaving it out of the ticket's reproduction steps.
- The backend no longer reads a button label from a `text` field. The extension sends the accessible name as `label` and never sends page text.
- A draft's evidence sentence now states the scope it was drawn from. A truncated session used to report "300 recorded events" when more had been recorded; the fact was only in the machine-readable provenance.

### Security
- Nothing yet

## [1.7.0] - 2026-10-22

### Added
- **Possible-friction signals in the ticket.** Repeated clicks on one control and clicks on an element the page never marked as a control now reach the draft, the export and the review page, instead of only the live status window. Every signal is a hypothesis, never a confirmed defect.
- **A click on a non-control is captured** when the element declares a role, is focusable, or is styled as a pointer. An ordinary click on empty space stays out of the capture.
- **Replay plans.** A capture can be exported as a destination-neutral, versioned plan of the path that was taken, with a stable handle for each control, the recorded failures and the friction signals. `GET /api/extension/recordings/<id>/replay` returns the plan, and `?format=playwright` returns a reviewable Playwright script. Panther never runs it.
- **A GitHub issues destination.** A reviewed draft can be delivered to a named repository as an issue, with its own credential, a stable identity per draft, an independent readback, a durable receipt, and the same preview-and-confirm contract as the local ticket service. The API host is fixed and the local ticket service stays loopback-only.
- **A destination catalogue.** `GET /api/extension/integrations` lists every destination with its status. The popup and the review page let a destination be chosen explicitly, and the chosen destination is frozen for the session.

### Changed
- The portable intent bundle moves to schema version 1.2, adding the optional `friction` array on a ticket. A 1.1 consumer must select the schema it understands and quarantine an unknown version.
- An automatic-delivery policy now names its destination and moves to policy version 2. A version 1 policy predates more than one destination and names the local ticket service implicitly.
- A regenerated draft keeps the fields a reviewer already changed, instead of discarding that decision.

### Fixed
- Nothing yet

### Security
- A GitHub credential is read only by the adapter. It never appears in a preview, a receipt, an export, a status report or a log, and a credential readable by anyone else is ignored.
- A delivery to a remote destination is chosen explicitly and its target is frozen for the session. A later configuration change blocks the admitted job instead of retargeting it.
- A replay plan never carries a typed value, because Panther never captured one, and it never authorizes execution.

## [1.6.0] - 2026-10-22

### Added
- Page-failure capture: uncaught exceptions, unhandled promise rejections, HTTP error responses and failed subresources are recorded in the same ordered timeline as the interactions, so a ticket can name a cause instead of only a symptom.
- A bounded main-world relay that lets an isolated content script observe the page's own uncaught failures. It forwards a message and a location only, holds no extension privilege, and reads no page text, input values or typed keys.
- A "Page-reported failures" section in the review UI, per-draft failure summaries, and a `GET /api/extension/recordings/<id>/diagnostics` route.
- `diagnostics` on each exported ticket and `diagnostic_count` on the exported recording, with a new `diagnostic_count` in draft provenance.

### Changed
- The portable intent bundle moves to schema version 1.1. The addition is compatible and optional; 1.0 consumers must select the schema they understand and quarantine an unknown version.
- A failure keeps the time it actually happened, so the recorded timeline stays truthful. Failures that happened before the capture began stay outside the consented window.
- A regenerated draft keeps the fields a reviewer already changed, instead of discarding that decision.

### Fixed
- Nothing yet

### Security
- A page controls its own error stream and can present a failure it did not have. A failure is therefore an observation, never a verified defect, a reproduction, or permission to act, and it can only ever reach a draft.
- Console output, stack traces, page text, typed values and keystrokes are never captured, including as part of a failure.
- No new permission, host permission or startup behaviour was added. The relay is installed only while a consented capture is active.

## [1.5.0] - 2026-10-21

### Added
- Live, numbered action feed and bounded rules-based interpretation in the status window, with stated goals, last-observed freshness, and evidence-linked possible-friction hypotheses.
- Separately opted-in local AI interpretation of new observations, with model/evidence coverage, request throttling, no remote fallback, and no ticket or execution side effects.
- Scoped cancellation and late-response fences for Off, Stop, consent withdrawal, stale status, session changes, and hidden or closed windows.

### Changed
- Captured-page status excludes the live projection; only the trusted monitor receives it. Saved results retain a bounded rules summary explicitly labeled as history.

## [1.4.0] - 2026-10-21

### Added
- Persistent status window opened by explicit On, with a toolbar control to reopen or focus it.
- Separate runtime/activity labels, bounded status freshness, event and ticket counts, and visible retained-history and delivery-receipt boundaries.
- Independent Off controls available during capture, generation, delivery, status waits, and startup.

### Security
- Opening, closing, polling, or restoring the status window does not start capture or the backend. No new browser permissions or startup service.
- Status-window messages cannot grant capture consent, select a page, start recording, or retry abandoned work.

## [1.3.0] - 2026-10-21

### Added
- Explicit browser On / Off controls with an on-demand native helper for Chrome and Edge on macOS/Linux.
- Scoped helper installation and uninstall, exact extension-origin registration, and private configuration.
- Lifecycle regression tests and an isolated real-browser verification report in `docs/BROWSER_CONTROL_TEST_RESULTS.md`.

### Changed
- Off preserves captured evidence, clears capture consent, cancels unfinished automatic ticket delivery, and stops only the browser-owned backend.
- Reopening the popup or browser does not start Panther; turning On again does not resume recording or abandoned delivery.
- Normal Stop & deliver keeps Panther on while the opted-in ticket workflow finishes. Panther creates tickets but does not execute their work.

### Fixed
- Shutdown proceeds even while browser storage is stalled, without hiding persistence uncertainty.
- Ordinary status polling detects a dead owned backend without reconnecting automatically.
- Final delivery checks prevent a new destination request when authority is revoked after receipt persistence.

### Security
- Native commands cannot supply executable paths, shell commands, environment variables, or alternate destinations.
- No login service, HTTP shutdown endpoint, automatic reconnect, or adoption of another process was added.

## [1.0.0] - 2026-10-21

### Added
- Initial release
- Manifest V3 browser extension for Chrome, Edge, Firefox, Safari
- Local-first Python backend on port 7890
- Opt-in consent-gated recording
- Page interaction tracing with secret redaction
- Local Ollama inference
- Intent decomposition into actionable tickets
- Screenshot capture at decision points
- Audio capture support
- Recordings library with video playback
- 30-day TTL and automatic cleanup
- HTTP Range support for video seeking

