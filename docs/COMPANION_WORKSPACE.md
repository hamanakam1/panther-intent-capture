# Capture, understand, choose the next step

Panther Intent Capture keeps a record of a chosen browser workflow. Panther
Companion helps interpret selected evidence in the context of a human's goal.
They work independently; a portable intent bundle is the explicit handoff.

## A practical desk layout

On an ultrawide display, reserve about 20% of the width for Intent Capture on
the left and 20% for Companion on the right. Use the middle 60% for the active
browser above a terminal. Keep the capture panel visible while interacting
with the chosen webpage. The monitor scales down for smaller displays and
keeps its Off control sticky.

The status window reports confirmed extension state and the next useful
navigation step. It does not grant capture consent. Start capture from
Panther's toolbar popup on the selected webpage, where the goal and session
choices appear before the Start button. Capture consent, screenshot consent,
automatic delivery, and live local AI remain separate choices.

## Review a capture

1. Stop capture to save the observed interactions and prepare a draft.
2. Open the saved result. The capture inbox can search title, page, or goal.
3. Read the ordered events and page-reported failures. These are observations;
   possible friction and local-AI output are hypotheses requiring judgment.
4. Edit the title, problem or improvement, and expected outcome. Save each
   edited draft. An unsaved notice remains visible until the latest edits have
   actually been saved; an older save response cannot clear newer edits.
5. Export the bundle or preview a ticket. A delayed export or preview cannot
   silently use wording changed while it was being prepared.

The standalone review desk is served by the backend at
`http://127.0.0.1:7890/ui/options/options.html`. It can review saved evidence
without the extension UI, but does not record browser interactions. The
extension monitor needs an installed, loaded extension to report live capture.
Opening the monitor as an ordinary HTTP page is not a substitute for that.

## Handoff to Companion

Choose **Copy intent bundle** in the saved capture, or **Download intent
bundle** to keep a JSON file. Both use the same destination-neutral
`intent-bundle` schema version `1.2` as **Export JSON**. Copy writes only after
your click, never reads the clipboard, and uses no new extension permission.
If the browser blocks clipboard access, use the download instead. No
background connection or submission occurs.

In Companion, choose **Import from Intent Capture**, then **Paste bundle JSON**
or **Choose JSON file**. Choose **Preview bundle** and review its source,
captured goal, and proposals before importing. Using the imported
goal is a separate choice: receiving a capture should not silently replace the
human's current goal. The default local Companion address is
`http://127.0.0.1:8765`; it must already be running. Custom ports can be opened
separately.

The bundle includes a stable capture identity, bounded recording metadata,
reviewable draft text, evidence references, provenance, and strict review and
execution fences. It excludes screenshot pixels and raw event payloads.
Export and import never authorize code execution or ticket delivery.
Unsaved edits block copying and downloading. If wording changes during export
preparation, copy again after saving. If a clipboard write was already in
flight, a visible warning identifies the copied text as an earlier version.

Useful patterns from comparable products informed this workflow: Jam's
ordered evidence and diagnostic context, and Sentry's minimization of captured
content. Panther keeps the human's stated goal and proposed next check
explicit rather than inferring authority from a recording.

- [Jam Resolve](https://jam.dev/resolve)
- [Sentry Session Replay](https://sentry.io/quickstart/session-replay/)
- [Intent bundle schema](../schemas/intent-bundle.schema.json)

## Verification boundaries

The regression suites cover state freshness, power/session isolation,
consent, redaction, capture persistence, draft review, identity-safe delivery,
and portable export contracts. The UI regressions additionally check real
monitor markup for duplicate IDs/documents, search behavior, unsaved edits,
and delayed preview/export boundaries. A package build checks the unpackable
extension resources.

Source tests and a package do not prove that an existing installed extension
has reloaded. Browser review, live extension capture, Companion import, model
quality, and real destination delivery are separate checks. An evidence draft
works without a model, Companion, or a configured delivery destination.
