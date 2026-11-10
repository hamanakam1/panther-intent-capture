# Compatibility

This page records what Panther Intent Capture supports today and where the
boundaries are. It is the source behind the supported-environments backlog item;
the shipped behaviour is described in the [README](../README.md).

## Supported environments

| Area | Supported | Notes |
|---|---|---|
| Extension | Chrome 116+, Microsoft Edge 116+ | Manifest V3, `minimum_chrome_version: 116`. Chromium-family builds only. |
| Backend runtime | Python 3.11+ | Standard library only; no third-party runtime dependency. |
| Backend host (browser-controlled startup) | macOS, Linux | Packaged helper registration via `backend/launchd` and `scripts/install_browser_helper.py`. Windows helper packaging is not implemented. |
| Backend host (local run) | any host running Python 3.11+ | Backend listens on `127.0.0.1:7890` by default (override with `EXTENSION_BACKEND_PORT`). |
| Capture target | ordinary `http` and `https` pages that allow extension injection | No per-site manifest entries are required; the extension uses the `activeTab` grant plus an explicit host permission for the local backend. |
| Ticket destinations | configured local ticket service | Local delivery adapters (including GitHub) are local-only and opt-in. |

## Browser scope

- Supported capture browsers: Google Chrome and Microsoft Edge, version 116 or
  newer, on the Chromium engine.
- Firefox and Safari manifests are experimental placeholders. They are not
  supported browser builds for capture.
- Video capture, audio capture, and media playback are disabled in this release.

## Out of scope for capture

- Browser settings pages, extension stores, embedded frames, and native desktop applications.
- Full page text; typed values and typed keys are excluded from evidence.
- Any destination beyond a configured local ticket service without an adapter.

## Verification environments

- Local development and qualification: macOS (arm64), Node 26, Python 3.14.
- CI: Linux, Node 22, Python 3.11 and 3.14.
- Real-browser qualification: Chromium 149 (`Google Chrome for Testing`) on macOS, isolated profile, synthetic loopback page.

See [BROWSER_QUALIFICATION.md](BROWSER_QUALIFICATION.md) and
[TEST_RESULTS.md](TEST_RESULTS.md) for what each environment actually ran and
what remains unqualified.
