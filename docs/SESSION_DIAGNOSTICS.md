# Session diagnostics

Panther records what you did on a page. It can also record what the page
itself said went wrong: an uncaught exception, an unhandled promise rejection,
an HTTP error response, or a subresource that failed to load.

A diagnostic is an **observation of what the page said**, not a verified
defect, not a reproduction, and never permission to act. Panther still
creates tickets; it does not implement the work.

## Why this exists

A capture of interactions alone can only say "the person clicked Save and
nothing happened next". That is a symptom with no cause. A capture that also
records the page's own failures can say "clicking Save raised
`TypeError: cannot read properties of undefined`" or "the request to
`/api/tickets` returned HTTP 500". The second is a ticket someone can act on.

Every comparable tool that records a browser session (error trackers, session
replay products, analytics session tools) records page-side failures for this
reason. Panther records them locally, under the same consent and the same
redaction rules as everything else it captures.

## What is captured

| Channel | What it means | Where it comes from |
|---|---|---|
| `uncaught_exception` | The page threw an uncaught error. | The page's own world, relayed to the content script. |
| `unhandled_rejection` | The page left a promise rejection unhandled. | The page's own world, relayed to the content script. |
| `http_error` | A request the page made returned an HTTP error status. | The browser's resource timing, observed in the content script. |
| `resource_error` | A subresource the page loaded failed to load. | The element's own load error, observed in the content script. |

Each record carries only an allowlisted set of fields: the channel, a bounded
and redacted message, a sanitized location, an HTTP status where one applies,
and the line and column of an uncaught exception. There is no stack trace, no
page text, no typed value and no image content.

## How the channels work

An extension content script runs in an isolated world. The isolated world can
observe DOM events and resource timing, but it **cannot** observe the page's
own uncaught exceptions or unhandled rejections: those are raised in the
page's world, and an isolated world never sees them.

Panther therefore installs a small relay in the page's world for the duration
of the capture. The relay listens for the two page-side failure events and
forwards a bounded message and location to the content script through a
`CustomEvent`. The relay holds no extension privilege, reads no page text and
no input values, and cannot create a ticket or run anything.

The `http_error` and `resource_error` channels need no relay at all: the
content script observes the browser's own resource timing and element load
errors directly.

The relay is installed once per page load, and a per-session nonce separates
Panther's relay from any other listener on the page.

## What is deliberately not captured

- **Console output.** `console.error` and `console.warn` are not recorded.
  They routinely contain payloads, user names and request bodies, and a page
  controls them completely.
- **Stack traces.** Only the message, the location and the line and column
  are kept.
- **Failures without a readable status.** A response the browser cannot
  report a status for (an opaque cross-origin response, for example) is not
  reported as a failure. A cached or opaque response is not a failure.
- **Anything from before the capture began.** A page that was already broken
  when you pressed Start is outside the consented window, so its earlier
  failures are left out. Failures that happen during the capture are kept,
  and each one carries the time it actually happened, so the recorded
  timeline stays truthful.
- **Page text, typed values and keystrokes.** These were never captured, and
  a failure does not become a way around that.

## Where a diagnostic shows up

- **The status window** lists a page-reported failure as one of the possible
  causes, with the evidence numbers of the events it was seen at, alongside
  the other friction hypotheses. It is labelled as an observation.
- **The review page** has a **Page-reported failures** section for the
  capture, and each draft shows the failures that belong to it.
- **The draft** names the failures in its description, counts them in its
  evidence sentence, and lists them as reproduction steps. A model proposal
  receives the failures as context and keeps them separate from its own
  unverified claims.
- **The portable export** carries them as `diagnostics` on each ticket and a
  `diagnostic_count` on the recording. See
  [integration contracts](INTEGRATIONS.md).
- **The local API** exposes them at
  `GET /api/extension/recordings/<id>/diagnostics`.

## Trust boundary

A page controls its own error stream. A page that wants to make Panther
record a failure it did not have can dispatch a failure event on the page's
document, and the relay's own event name is observable by page scripts. This
is the same property every error tracker and session replay tool has, and it
is why Panther treats a failure as an observation rather than a fact.

What a page cannot do is change the *time* of an HTTP failure, because that
comes from the browser's own resource timing. And what a page cannot do at
all is turn a failure into a ticket, an execution, or a verified defect: a
failure only ever reaches a draft, and a draft always requires review.

## Verification

`docs/SESSION_DIAGNOSTICS_TEST_RESULTS.md` records the real-browser
observations, including the isolated-world behaviour that motivated the
relay and the boundaries the browser actually enforces.
