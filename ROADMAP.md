# Panther Intent Capture roadmap

The product goal is to make a user's observed workflow and desired change understandable to another system through portable exports and explicitly configured adapters. Capture, interpretation, human review, delivery, and execution remain distinct steps.

## Implemented in the current source

- Explicit chosen-tab capture for Chrome/Edge 116+ on ordinary HTTP(S) pages.
- Events-first capture with a floating status/control panel and popup recovery actions.
- Persistent browser status window with runtime/activity separation, bounded status freshness, retained-history labeling, and independent Off controls. It opens on explicit On, not at login or browser startup.
- Live numbered action feed, conservative rules-based interpretation and evidence-linked friction hypotheses; separately opted-in bounded local AI insights that never create tickets or execute work.
- Page-reported failure capture: uncaught exceptions, unhandled promise rejections, HTTP error responses and failed subresources, recorded in the same ordered timeline as the interactions. Failures are observations of what the page said, never verified defects, and never permissions to act.
- Possible-friction signals in the ticket: repeated clicks on one control, and clicks on an element the page never marked as a control. Both are hypotheses and reach the draft, the export and the review page.
- Replay plans: a destination-neutral, versioned plan of the path that was taken, with a stable handle for each control, the recorded failures and the friction signals, plus an optional Playwright rendering. Panther never runs a plan, and a plan never carries a typed value.
- A GitHub issues destination with its own credential, a stable identity per draft, an independent readback, a durable receipt, and the same preview-and-confirm contract as the local ticket service. The API host is fixed and the local ticket service stays loopback-only.
- A destination registry and catalogue, so a new destination works with the existing routes, the popup, the review page and the automatic-delivery policy.
- A bounded main-world relay that lets an isolated content script observe the page's own uncaught failures, with a per-session nonce, no extension privilege, and no page text, values or keystrokes.
- Failures keep the time they actually happened, so the recorded timeline stays truthful; failures from before the capture began stay outside the consented window.
- A "Page-reported failures" review section, per-draft failure summaries, and a local `GET /recordings/:id/diagnostics` route.
- Regeneration that keeps the fields a reviewer already changed, so a new generation never discards a reviewer's decision.
- Explicit browser On / Off with a native helper on macOS/Linux; no login service or automatic reconnect. Off cancels unfinished delivery and stops only the owned backend.
- Allowlisted control metadata; no typed values or keystrokes; URL and common-secret sanitization.
- Separately consented screenshots, bounded to five per session. Pixels remain unredacted.
- Durable browser capture state, idempotent backend upload, interrupted-upload recovery, and separate draft-generation retry.
- Private local storage, retention limits, and capture deletion.
- Automatic evidence drafts after Stop, without model inference.
- Explicit local AI generation with provenance and visible errors.
- Review UI with editable title, description, and acceptance criteria.
- Destination-neutral, versioned JSON export with evidence references.
- Formal Draft 2020-12 intent-bundle schema, positive/negative validation tests, and explicit version-migration policy.
- Local ticket-service preview and confirmed single-draft submission, deterministic identity, durable delivery receipts, and independent readback.
- Separately consented automatic capture-to-ticket delivery: frozen destination and proposals, a five-ticket session cap, 24-hour expiry, bounded retries, durable restart recovery, visible progress, and cancellation.
- Backlog and `no-auto` fences on dashboard submissions; no execution authorization.
- Synthetic browser-controller, HTTP, storage, inference, and delivery contract tests.

These are implementation claims. Synthetic tests are not evidence of loaded-extension acceptance, live model quality, live dashboard delivery, or cross-site compatibility.

The [1.2.0 verification report](docs/AUTOMATION_TEST_RESULTS.md) separately records a loaded-Chromium capture/recovery test against a synthetic destination. It does not establish a user's live destination compatibility or broad site coverage.

## Next: qualify the complete user workflow

- Exercise the unpacked extension in fresh Chrome and Edge profiles, including same-origin reloads, SPA routes, tab changes, service-worker suspension, and browser restart.
- Verify the toolbar popup, persistent status window, and floating panel remain usable with long text, zoom, keyboard navigation, screen readers, and narrow windows.
- Run consented local ticket service captures and verify useful, edited tickets from preview through live readback without allowing autonomous execution.
- Measure draft usefulness with representative examples: accurate evidence, clear expected behavior, useful acceptance criteria, and minimal manual correction.
- Test an explicitly configured local model and report model/version, errors, latency, and whether any media was analyzed.
- Establish a small, published compatibility matrix from actual website/browser checks.
- Exercise a full user-consented capture of a page that fails, in a real browser, and record the result in the diagnostics report.

## Next: make integrations easier to extend

- Add destination adapters behind the same preview, confirmation, idempotency, and delivery-receipt contract.
- Prioritize a configurable local importer after the local ticket service and GitHub workflows are qualified.
- Add destination setup and capability discovery without exposing credentials to captured pages.
- Provide deliberate update/link-existing workflows; resubmitting edited content must not silently overwrite an existing ticket.
- Improve evidence transfer and attachments with separate consent, access control, and clear retention behavior.
- Provide an importer for the version 1.2 intent bundle, including the `diagnostics` and `friction` fields, so another system can carry a page-reported failure and a friction hypothesis through without presenting either as a verified defect.
- Make a replay plan consumable by a verifier: an importer that turns a plan and its recorded failures into a check another system can run.

## Next: stronger privacy and operational controls

- Pair or allowlist extension installations instead of treating extension-origin checks as authentication.
- Add redaction review and screenshot masking before storage or export.
- Provide explicit receipt/history retention controls while explaining their effect on duplicate prevention.
- Improve large-session coverage, event truncation disclosure, and cross-frame capture with explicit permission boundaries.
- Qualify native-helper packaging across platforms, upgrades, custom profiles, and uninstall behavior while retaining explicit browser startup. Windows helper packaging remains unimplemented.
- Consider dead-click detection that watches the page's own DOM for a click that produced no response, with the same "observation, not proof" framing, and a separately consented console channel.

## Deferred capabilities

- Video and audio capture, replay, and synchronized media evidence. These remain disabled in the current release.
- Firefox and Safari builds. Existing manifests are unsupported previews.
- Native desktop capture and operating-system integrations. Browser support does not imply arbitrary application support.
- Streaming inference, session comparison, heatmaps, and DOM reconstruction.
- Automatic coding-agent execution. A captured workflow or delivered ticket never grants permission to run code, change a service, or publish work.

## Design commitments

Capture requires an explicit start on a chosen page. Evidence and inference must be distinguishable. Failures remain visible. Delivery requires either manual review confirmation or a distinct, bounded session opt-in to send unreviewed proposals. Delivery remains separate from execution: Panther captures intent and creates tickets, never implements them. Local defaults and deliberate exports preserve the user's control over where captured information goes.

