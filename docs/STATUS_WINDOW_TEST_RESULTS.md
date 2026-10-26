# Persistent status window verification — 1.4.0

Verified 2026-10-21. This report separates automated regressions, loaded-browser observations, and remaining operator checks. It is not evidence of a particular deployment's installation or live ticket acceptance.

## Automated checks

- **166 JavaScript tests passed**, no failures or skips (`node --test tests/*.mjs`, Node 26.11.1).
- **122 Python tests passed**, no failures or skips (`python3 -B -m unittest discover -s tests -p 'test_*.py'`, Python 3.14.6).
- Packaging produced a **25-file Chromium ZIP, version 1.4.0**. All relative script/style/module resources resolve inside the packaged set. No new extension permission was added.
- `git diff --check` passed. Committed merge-marker remnants in the manifest-version test and roadmap were removed.

The new regressions cover singleton window creation/focus, exact extension-origin sender checks, restricted monitor commands, independent power controls, status timeout/freshness, stale-response fencing, Off during startup/Stop/cancellation, retained evidence after Off then On, text-only rendering, and zero launch side effects from opening/polling/closing the view. Generation, delivery, blocked, unknown, and historical-receipt combinations use controlled fixtures; they do not prove a real destination accepted a ticket.

## Loaded Chromium check

Used Chromium 149.0.7827.55 on macOS with a separate temporary profile, native-host registration, and data directory. The final qualification used headless Chromium with real extension windows/native messaging, plus rendered screenshots. No personal browser profile was changed. No ticket destination was configured, and no AI inference or external ticket write was requested.

Observed:

1. Opening the status window while Off kept runtime Off and left the backend port without a listener.
2. Eight concurrent open requests returned the same window ID. Opening an existing monitor reused it; closing and reopening created one replacement.
3. Explicit On in the window started its registered native backend. The UI showed **On / Idle**, zero events, and capture consent remained false. The backend health endpoint was checked independently.
4. Closing the monitor left the backend On without starting capture. Reopening recovered the current status. Explicit On from the toolbar popup with the monitor closed also opened exactly one window.
5. A synthetic loopback page was explicitly admitted through the popup's runtime command path. Actual content-script events appeared in the monitor as **Capturing** with an increasing count and zero screenshots.
6. The monitor's **Stop & generate drafts** button saved that two-event capture and displayed **Ready**, one evidence draft, and a review button. Review opened the saved result; delivery was visibly unconfigured and no AI was used.
7. Off during a second capture stopped the native-owned backend. The monitor remained open with **Off / Idle**, two retained events, and an explicit historical-information label. A subsequent On left consent false and the capture retained/paused; it did not resume recording or upload.
8. At 400- and 320-pixel viewport widths there was no horizontal overflow. The sticky Off control remained in view after scrolling at 320 pixels. On, Capturing, and Off screenshots were visually reviewed; local artifacts were not published.
9. After explicit Off, closing and reopening the test browser did not create a monitor or start a listener. Opening the popup again confirmed Off and retained recovery state.

## Boundaries and remaining qualification

- The chosen-page admission used an extension runtime test driver on a synthetic loopback page, not a physical toolbar `activeTab` grant. Headless Chromium retained the monitor as its last-focused window despite a focus request, so the fixture was admitted with the monitor closed and then the monitor reopened. A headed Edge/Chrome check of focus switching and physical toolbar capture remains necessary.
- `windows.get(..., {populate: true})` did not expose tab URLs with the current scoped permissions in this browser. Normal reuse was verified through exact `runtime.getContexts()` identity. The short document-loading fallback fails closed when it cannot confirm the cached window; it does not add a broad permission or risk opening duplicates. Synthetic tests cover this failure path.
- This is a normal browser window, not an OS-level always-on-top utility. The requested size can be adjusted by browser/window-manager constraints.
- Native On confirms an owned process, not continuous backend, model, or destination health. Delivery counters are historical receipts, not continuous destination readback.
- Real automatic generation/delivery transitions, a configured model, personal Edge installation/reload, screen-reader behavior, browser zoom, broad website compatibility, and live destination readback were not qualified by this window check.
- The temporary test backend was shut down. Existing personal helper registration, captured data, and other services were not modified.

## Correction found after 1.4.0

The shipped status-window page carried a stale second copy of four sections after its closing `</html>` tag. The browser folds that trailing markup back into the body, so the window rendered the understanding, activity, evidence and control sections twice, and `getElementById` resolved to the first copy of each control while the second copy stayed stale. The 1.4.0 loaded-browser check above did not notice it, because the first copy of each control behaved correctly.

The duplicate is removed, and a markup-integrity regression now keeps every extension page a single document with unique element ids. The fix changes what the window shows, not what it does: the same controls, the same status, the same Off actions, in one copy.
