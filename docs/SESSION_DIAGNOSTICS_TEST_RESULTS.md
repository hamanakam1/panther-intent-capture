# Session diagnostics verification — 1.6.0

This report records what was observed in a real browser for the page-failure
channels added in 1.6.0, and what remains unverified. It is separate from the
synthetic unit suites: those prove the contract, this report records browser
behaviour.

## The question that shaped the design

Can an extension content script observe a page's own uncaught exceptions?

A content script runs in an isolated world. The isolated world shares the DOM
with the page but not the JavaScript context, so a page's uncaught errors are
raised somewhere an isolated world may never see. This was measured rather
than assumed.

Measured in Chromium 149 (`Google Chrome for Testing`), with an isolated world
created the way an extension creates one, against a page that threw an
uncaught error, left a promise rejection unhandled, posted a `message` event,
dispatched a `CustomEvent` on `document`, and failed to load a subresource:

| Observation | Result |
|---|---|
| Isolated `window` listener for `error` | **Not called** (0 of 1) |
| Isolated `window` listener for `unhandledrejection` | **Not called** (0 of 1) |
| Isolated `window` listener for `message` | Called (1 of 1) |
| Isolated `document` listener for a page-dispatched `CustomEvent` | Called (1 of 1) |
| Isolated `document` listener for a failed subresource | Called (1 of 1) |
| Isolated `performance.getEntriesByType("resource")` | Exposed the page's entries, with `responseStatus` |

The conclusion drove the implementation: the two page-side failure channels
need a relay installed in the page's world, and the two browser-side
channels do not.

## Real extension, real page

A real Manifest V3 extension, loading the repository's own
`extension/shared/capture.js` and `extension/content/content.js` unmodified,
in Chromium 149, against a local HTTP page. The extension injected the relay
with `chrome.scripting.executeScript({world: "MAIN", func, args})`, injected
the content script, and started a capture.

Captured `page.diagnostic` messages, as the extension received them:

```json
[
  {"type": "page.diagnostic", "sessionId": "probe-session",
   "payload": {"type": "diagnostic", "ts": 1792656481436, "url": "http://127.0.0.1:8095/",
               "diagnostic": {"kind": "http_error", "message": "A request returned HTTP 500",
                              "source": "http://127.0.0.1:8095/boom", "status": 500}}},
  {"type": "page.diagnostic", "sessionId": "probe-session",
   "payload": {"type": "diagnostic", "ts": 1792656481447, "url": "http://127.0.0.1:8095/",
               "diagnostic": {"kind": "uncaught_exception",
                              "message": "Uncaught TypeError: probe shipped main world error",
                              "source": "http://127.0.0.1:8095/", "line": 3, "column": 28}}},
  {"type": "page.diagnostic", "sessionId": "probe-session",
   "payload": {"type": "diagnostic", "ts": 1792656481436, "url": "http://127.0.0.1:8095/",
               "diagnostic": {"kind": "unhandled_rejection", "message": "probe shipped rejection", "source": ""}}}
]
```

Observed and confirmed:

- `chrome.scripting.executeScript` with `world: "MAIN"` is accepted by the
  browser and runs in the page's world. The relay's listeners then receive
  the page's uncaught exception and its unhandled rejection.
- A `CustomEvent` dispatched on `document` from the page's world reaches a
  content script listener in the isolated world.
- The HTTP failure carried `status: 500` and the failing request's URL, and
  its timestamp was the **resource's own time**, not the time the message
  arrived.
- The uncaught exception carried its message, the script URL and its line and
  column, and no stack trace.
- No page text, input value or keystroke appeared in any message.

## Two behaviours the browser enforced that shaped the code

**A content script stops listening when the background does not answer.**
Panther's content script treats an unanswered capture message as a lost
background and stops. During qualification a test harness that failed to
reply to `page.interaction` produced zero diagnostics while the page panel
was still visible. This is Panther behaving correctly, and it is recorded
here because it is easy to misread as a broken capture.

**A service worker is not kept alive by timers.** A qualification harness that
collected results in a timer and wrote them afterwards lost everything when
the worker was suspended. The shipped background persists each diagnostic as
it arrives instead.

## Boundaries this report does not establish

- A **real, user-consented capture** through Panther's own popup was not
  exercised. The qualification drove the shipped relay and the shipped
  content script through the extension APIs directly, because the popup's
  `activeTab` grant needs a real user gesture.
- **Console output** is not captured, by design, and no browser behaviour was
  measured for it.
- **Cross-origin responses** without a readable status were not exercised.
  They are not reported as failures.
- The **page-forgery boundary** was confirmed rather than merely assumed: a
  page that dispatches its own failure event on the document is recorded by
  Panther. See the trust boundary in
  [session diagnostics](SESSION_DIAGNOSTICS.md).
- **Windows, Firefox and Safari** were not exercised. The project supports
  Chrome and Edge 116+ only.

## Automated coverage

The synthetic suites cover the contract these observations depend on:
`tests/capture-content.test.mjs` (capture, relay, nonce, window boundary and
bounds), `tests/capture.test.mjs` (recording, sender authority, refusal
after Stop), `tests/live-activity.test.mjs` (the projection and its wording),
`tests/redaction.test.mjs` (the allowlist),
`tests/test_redaction_parity.py` (the extension and the backend agree), and
`tests/test_backend.py` and `tests/test_http.py` (the drafts, the endpoint
and the export).
