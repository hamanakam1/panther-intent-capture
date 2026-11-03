# Contributing to panther-intent-capture

Thank you for considering a contribution! panther-intent-capture is an open-source browser extension that observes page usage with explicit consent and runs local inference on recordings. We welcome improvements of all sizes.

## How to contribute

1. **Fork the repo** and create a branch: `git checkout -b your-feature-name`
2. **Make your changes** — keep them focused and well-tested
3. **Run the checks** — see "Verification" below
4. **Open a pull request** — describe what you changed and why

## Verification

### Extension
- Load the unpacked extension in Chrome or Edge 116+ in a separate test profile and verify capture starts/stops with consent. Firefox/Safari are unsupported previews.
- Confirm the visible badge appears while recording
- Confirm typed values and keys are absent from stored events and screenshot capture requires separate consent
- Verify the floating controls, automatic evidence drafts, offline upload retry, and visible generation failures
- Verify the floating panel is usable without a mouse: it is reachable by keyboard, shows a visible focus ring, announces its state, and Escape dismisses it while returning the keyboard to where it was. Focus is not trapped, because the panel lives on a page the user still has to reach.
- Verify automatic delivery defaults off, locks its target/mode at Start, shows stages/counts, and stops remaining work on cancellation. Test expiry, duplicate uploads, worker/browser/backend restart, and a lost POST response against a fake destination.
- Verify browser On is the only native-host launch path; status, alarms, browser restart, and disconnect must not launch it. Verify Off remains reachable during capture/upload/generation, cancels unfinished delivery, preserves evidence, and stops only the owned backend. Use an isolated browser profile and temporary helper/data paths; never alter a personal native-host registration without approval.
- Verify the status window opens or focuses a single view, does not power on from status/open/close, shows stale or unknown status honestly, and keeps Off reachable during stalled status and actions. Verify retained evidence never appears as resumed capture after Off then On. Separate browser checks from synthetic race tests.
- Verify live interpretation distinguishes observed actions from rules and local-model hypotheses; redacts and bounds its evidence; never submits tickets; and resets optional AI opt-in on Off, Stop, stale/withdrawn consent, session changes, and window reload. Use synthetic events and a mocked local model to test malformed responses, throttling and late-result races. Real-model usefulness is separate qualification.

### Backend
```bash
cd backend
./start.sh
curl http://127.0.0.1:7890/api/extension/health
```

### Unit tests

The backend and core test suite require no third-party runtime packages. For complete JSON Schema validation, install the test-only validator in a virtual environment:

```bash
python3 -m pip install jsonschema==4.26.0
```

Then run:

```bash
node --test tests/*.mjs
python3 -B -m unittest discover -s tests -p 'test_*.py' -v
python3 scripts/package_extension.py
```

### Loaded-browser qualification

The synthetic suites cannot show that the unpacked extension loads in a real browser or that a consented capture reaches the local backend. `scripts/qualify_browser.mjs` does that on a real Chromium, in an isolated profile, against a synthetic loopback page:

```bash
npm install
npx playwright-core install chromium
node scripts/qualify_browser.mjs --report browser-qualification.md
```

It needs the backend port `127.0.0.1:7890` free, and it fails loudly rather than quietly. It registers Panther's native helper inside a temporary browser profile, so no personal registration, helper file or capture directory is touched. See [loaded-browser qualification](docs/BROWSER_QUALIFICATION.md) for what it checks and what it does not prove.

## Code style

- JavaScript: ES modules, `import`/`export`, no `var`
- Python: type hints where practical, black-compatible formatting
- Commit messages: imperative mood, concise ("Add video range support", not "Added video range support")

## Privacy-minded contributions

Public source, documentation, issues, screenshots, and examples must not identify a contributor's private systems or deployments. Use generic adapter names and synthetic origins, ticket data, and fixtures. Keep installation paths, internal architecture, real operational screenshots, and deployment-specific evidence local. A public repository is not permission to publish the systems that integrate with it.

The [public-content privacy check](docs/public-content-privacy.md) scans tracked
content using a private policy. Keep its real entries out of public fixtures and
logs; changes to workflows or the checker need a maintainer-reviewed manual scan.

Any feature that captures or stores user data must:
- Be opt-in
- Minimize captured data and filter common secrets; never describe screenshot pixels as redacted
- Show a visible indicator while active
- Allow user deletion

Use temporary `PANTHER_DATA_DIR` storage and synthetic dashboard endpoints for automated tests. Never create live dashboard tickets without explicit operator approval for a bounded pilot. Report unit tests, loaded-browser checks, local model checks, and confirmed live ticket delivery separately. CI runs JavaScript, Python, and JSON Schema regressions, then retains an unpackable Chromium extension ZIP. If `jsonschema` is unavailable locally, seven validator tests explicitly skip; the remaining structural tests are not equivalent validation.

## Questions

Open an issue or start a discussion. We're happy to help.
 
