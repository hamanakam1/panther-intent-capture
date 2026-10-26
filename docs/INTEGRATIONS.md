# Integration contracts

Panther separates browser capture and draft review from destination delivery. The built-in adapter supports the specific local ticket-service protocol below, not an arbitrary ticket system. A versioned JSON intent bundle is the integration point for other systems; there is no universal API adapter or native application capture in this release.

## Portable intent bundle

Choose **Save draft edits**, then **Export JSON** in the review UI. Exports contain the currently saved drafts, source metadata, bounded evidence references, and explicit authority flags. They do not contain screenshot image data, video files, raw event arrays, local filesystem paths, or destination credentials.

The export has `schema_version: "1.2"`. The `schema` value identifies this documented contract. The machine-readable [Draft 2020-12 JSON Schema](../schemas/intent-bundle.schema.json) defines the supported fields, bounds, and fixed review/authority flags. Validation establishes structure, not evidence truth or delivery. This abbreviated synthetic example uses the actual field names:

```json
{
  "schema": "https://github.com/hamanakam1/panther-intent-capture#intent-bundle",
  "schema_version": "1.2",
  "producer": "panther-intent-capture",
  "exported_at": 1792537200,
  "recording": {
    "id": "example-capture",
    "source_url": "https://example.test/settings",
    "title": "Settings",
    "stated_goal": "Remember my selected filter",
    "capture_mode": "events",
    "start_time": 1792537100,
    "end_time": 1792537130,
    "duration_ms": 30000,
    "event_count": 3,
    "screenshot_count": 0
  },
  "tickets": [
    {
      "id": "draft-example",
      "title": "Remember the selected filter",
      "description": "The selected filter resets when returning to this page.",
      "hypothesis": "",
      "steps_to_reproduce": ["Select a filter", "Leave the page", "Return"],
      "suggested_verification_steps": [],
      "acceptance_criteria": ["The selected filter is restored on return"],
      "desired_behavior": "Remember my selected filter",
      "questions": [],
      "component": "unspecified",
      "priority": "medium",
      "evidence": "Three recorded navigation and control events; verify the reported reset.",
      "evidence_refs": [{"kind": "event", "event_index": 1, "type": "change", "timestamp_ms": 1792537101000}],
      "diagnostics": [{"kind": "http_error", "event_index": 3, "message": "A request returned HTTP 500", "source": "https://example.test/api/tickets", "status": 500}],
      "friction": [{"kind": "repeated_clicks", "title": "Repeated clicks on one control", "detail": "3 clicks on the same control within 10 seconds may indicate an unclear or unresponsive control, or intentional repetition. No failure is verified.", "event_indices": [1, 2, 3], "hypothesis": true}],
      "screenshot_timestamps": [],
      "source_url": "https://example.test/settings",
      "provenance": {
        "origin": "observed_evidence",
        "producer": "panther-intent-capture",
        "recording_id": "example-capture",
        "mode": "observed",
        "model": null,
        "generation_revision": 3,
        "evidence_kind": "observed_events",
        "proposal_verified": false,
        "event_count": 3,
        "events_total": 3,
        "events_truncated": false,
        "screenshots_count": 0,
        "media_analyzed": false,
        "diagnostic_count": 1
      },
      "status": "draft",
      "requires_review": true,
      "execution_authorized": false
    }
  ],
  "authority": {"export_only": true, "requires_review": true, "execution_authorized": false}
}
```

Recording times are Unix seconds; event references use Unix milliseconds. `event_index` is one-based within the observed event list. A reference is evidence provenance, not proof of the proposed change or a promise that an image is embedded. Source URLs are sanitized. Some optional metadata may be missing from older captures.

`diagnostics` lists the page-reported failures that belong to the draft, each with the `event_index` of the recorded event it was observed at. In an exported draft that index refers to the analysed event sequence, the same basis as `evidence_refs`. A failure is what the page's own error stream said: it is an observation, not a verified defect, not a reproduction, and not a permission to act. `diagnostic_count` is the number of failures in the whole capture. Consumers should present a failure as something the page reported, and should not present it as a confirmed cause. See [session diagnostics](SESSION_DIAGNOSTICS.md).

Observed drafts summarize actions and the supplied goal without a model. AI drafts identify their model, mode, and generation revision. Their `hypothesis` and `suggested_verification_steps` are unverified proposals kept separately from `steps_to_reproduce`, which is derived from captured events. `proposal_verified: false` means the proposed problem has not been established by those events. Preserve those distinctions in downstream tools. Preserve unresolved questions and missing acceptance criteria instead of inventing certainty. Draft IDs remain stable for the recording, generation mode, and draft position; editing a draft does not create a new identity.

The `evidence` sentence states the scope the draft was drawn from. When a recording has more events than the generator analyses, it says how many of how many were used and that the rest were not analysed; `provenance.events_total` and `provenance.events_truncated` carry the same fact in machine-readable form. Importers should show the scope rather than presenting a truncated analysis as a complete one.

### Versioning and validation

Consumers should select a schema using `schema_version` and explicitly reject or quarantine unknown versions for review. Version 1.2 has closed object fields: adding a wire field requires a new schema version, even when the new producer considers it optional. Compatible additions use a new minor version; removal, changed meaning, or incompatible types require a new major version. Documentation clarifications that do not change valid payloads do not change the version.

Version 1.2 adds the optional `diagnostics` array on a ticket, the optional `diagnostic_count` on the recording, the optional `diagnostic_count` in provenance, and the optional `friction` array on a ticket. A 1.2 producer always emits `diagnostics` and `friction` on every ticket; they are empty when the capture recorded no failure and no friction signal. A consumer that only understands an earlier version must select the schema it understands and treat a 1.2 bundle as an unknown version to quarantine for review, exactly as it would for any other unknown version. Migration requires no rewriting of existing payloads: a 1.0 bundle remains a valid 1.0 bundle, and the producer's own version, not the consumer's, decides which contract it was written against.

`friction` lists the possible-friction hypotheses derived from the recorded actions. Like a failure, a friction signal is a possibility about what happened, not a confirmed defect and not a permission to act. It always carries `hypothesis: true`.

There is no automatic bundle migration or importer in this release. Any future migration must preserve capture/draft identities, provenance, unresolved questions, and the distinction between observations and proposals. It must never turn `execution_authorized` on, remove review requirements, rewrite existing delivery receipts, or silently submit to another system. Keep the original artifact alongside a migrated one.

Schema regressions validate real observed-mode exports and real generator/exporter output with a mocked AI response. Install the test-only `jsonschema==4.26.0` dependency to run the full validator suite; it is not needed by the backend at runtime. CI installs it explicitly. Tests report validator skips, rather than passing structural checks off as JSON Schema validation, when it is unavailable locally.

## Local ticket service adapter

There is no default target. Set `PANTHER_DASHBOARD_URL` before backend startup or use `--dashboard-url` during browser-helper setup to pin a compatible loopback HTTP(S) origin. `http://127.0.0.1:8080` is a synthetic example, not a detected service. Without configuration, status reports `unconfigured` and delivery is unavailable; capture and JSON export still work. Paths, query strings, credentials, non-loopback hosts, and redirects are rejected. `localhost` is canonicalized to `127.0.0.1`, and environment HTTP proxies are disabled for adapter requests.

### Updating an existing installation

The public integration identifier and HTTP route prefix are now `ticket-service` and `/api/extension/integrations/ticket-service`. Update the backend and extension together, reload the unpacked extension, and update custom clients to use the documented routes. Existing explicit `dashboard_url` helper settings and `PANTHER_DASHBOARD_URL` values remain supported; the project does not modify installed configuration. The generic outbound `system` value is now `ticket-service`. Changed payloads require a fresh preview; existing receipt hash conflicts remain fail-closed and must be reconciled, never deleted to bypass review.

The backend calls these existing dashboard routes:

| Operation | Dashboard route | Meaning |
|---|---|---|
| Status | `GET /healthz` | Reachability only; no ticket data is queried. |
| Create or deduplicate | `POST /api/master/add` | Create a review-fenced backlog item using a stable seed. |
| Verify | `GET /api/tix/ticket?key=<returned-key>&seen=0` | Confirm the exact item without marking its conversation as read. |

Panther's extension does not call the dashboard directly. The dashboard permits Origin-less local automation but rejects extension browser origins on its board-write routes. Panther retains that boundary and does not enable broader dashboard CORS.

The outbound ticket has:

- `seed_key`: `panther:capture:<recording-id>:<ticket-id>`.
- `source`: `panther-intent-capture:agent-proposal`.
- `status: "backlog"`, `tags: ["panther", "needs-triage", "no-auto"]`.
- A detail starting with `not authorized for autonomous execution`.
- Title, intent summary, source URL/times, provenance, observed evidence, reproduction steps, acceptance criteria, and evidence references.

The adapter respects the dashboard's 200-character title and 4000-character detail limits. The preview shows the bounded payload and warns that the full draft remains in the neutral export. It does not upload screenshots or set the dashboard's separate readiness record to `NEEDS_REVIEW`.

Manual submission requires a review confirmation tied to the current preview hash, including its destination URL, exact outbound payload, and full reviewed draft. Changing the destination or payload requires a new preview. Separately opted-in [automatic sessions](AUTOMATION.md) instead freeze a bounded delivery policy in the extension at capture Start. The backend admits that original policy on upload and freezes generated proposals before sending; it does **not** claim a human reviewed those proposals. Both paths use the same adapter and delivery identity. The backend verifies the returned item number, capture identity, source, content, backlog status, and review tags before first reporting `delivered`. HTTP 200 or `ok: true` alone is insufficient: the dashboard can return a null item when intake is paused or capped.

### Delivery outcomes and retry behavior

| State | Meaning | Next action |
|---|---|---|
| `delivered` | Creation/deduplication and independent content readback matched at `verified_at`. | Open the ticket for dashboard review. Repeating the same request reuses the receipt. |
| `pending` | A request or readback was uncertain; delivery is unverified. | Retry the same draft. If the ticket ID is known, only readback is retried. |
| `refused` | No valid item ID was returned, including intake holds/caps. | Resolve the refusal, then retry with the same identity. |
| `conflict` | This identity was submitted with different content. | Review the existing dashboard item or deliberately create a distinct draft. |

An unknown POST result may mean the dashboard already created the item. A retry keeps the same deterministic seed so the dashboard can return that existing item. Never generate a new seed merely because a request timed out. A `created: false` response is valid when it includes the existing item and its readback matches.

A reused delivered receipt returns `previously_verified: true` and retains its original `verified_at` timestamp. It performs no new dashboard request and does not establish that the ticket's current content or execution fences are unchanged. Clients must describe that result as previous verification, not a fresh check.

Receipts are private JSON files under `PANTHER_DATA_DIR/deliveries/`, written atomically before the request. They retain the target, seed, content hash, state, and returned item metadata. A receipt write failure prevents the initial POST. Receipts remain after deleting a capture so a later duplicate attempt can still be recognized. Capture deletion does not delete dashboard tickets, exports downloaded elsewhere, or these receipts. Removing a receipt is not a supported ticket-delete or ticket-update operation.

## Panther HTTP API

The backend binds to `127.0.0.1:7890` by default. `/` serves the review UI. API routes begin with `/api/extension/`.

| Method and route | Purpose |
|---|---|
| `GET /health` | Backend identity and advertised capabilities, including the `bundle_schema_version` of the export contract. |
| `POST /record` | Upload a consented capture with stable session identity. Used by the extension. |
| `GET /recordings` | List capture summaries. |
| `GET /recordings/<id>` | Get one capture's public metadata. |
| `GET /recordings/<id>/events` | Inspect its sanitized local event evidence. |
| `GET /recordings/<id>/diagnostics` | Inspect the page-reported failures it recorded. |
| `GET /recordings/<id>/screenshots` | Inspect separately consented local screenshot pixels. |
| `DELETE /recordings/<id>` | Delete local capture artifacts and drafts. |
| `POST /tickets/<id>` | Generate an observed draft by default; `{ "use_ai": true }` explicitly requests local AI. |
| `GET /tickets/<id>` | Read the saved draft bundle. |
| `POST /tickets/<id>/review` | Save allowed draft edits. |
| `GET /export/<id>` | Export the portable JSON bundle. |
| `GET /automation/<id>` | Inspect automatic job status, stage, counts, retry timing, and delivery receipts; manual captures return `disabled`. |
| `POST /automation/<id>` | `{ "action": "cancel" }` stops remaining delivery; `{ "action": "retry" }` advances an eligible retry without resetting its budget or expiry. |
| `GET /integrations` | List every delivery destination with its status. |
| `GET /integrations/ticket-service` | Check dashboard health-route reachability. |
| `GET /integrations/github` | Check the GitHub destination's configuration and reachability. |
| `GET /recordings/<id>/replay` | Read the replay plan for a capture, as JSON or as a Playwright script. |
| `POST /integrations/ticket-service/preview/<id>` | Build the exact dashboard payload without contacting it. |
| `POST /integrations/github/preview/<id>` | Build the exact issue payload without contacting GitHub. |
| `POST /integrations/ticket-service/submit/<id>` | Submit one confirmed, previewed draft and verify it. |
| `POST /integrations/github/submit/<id>` | Submit one confirmed, previewed draft as an issue and verify it. |

POST and DELETE requests require an `X-Panther-Client` header. JSON POST requests use `Content-Type: application/json`. Browser requests must come from a permitted extension origin or the backend's loopback origin; unrelated website origins are refused. This header is not a secret or authentication token. The API is intended for a single-user local environment.

Review and preview bodies use:

```json
{
  "ticket_id": "draft-example",
  "patch": {
    "title": "Remember the selected filter",
    "description": "The selected filter resets when returning to this page.",
    "acceptance_criteria": ["The selected filter is restored on return"]
  }
}
```

Manual submit repeats the reviewed body and adds `"confirmed": true` plus the exact `"payload_hash"` returned by preview. Changing the content invalidates that preview. The shipped UI handles this sequence; custom clients must preserve the same explicit review gate, or use the separately consented automatic-session contract. Automation must never be inferred from capture consent alone.

## Building another adapter

Keep the capture and neutral export schema unchanged. Map a reviewed draft to the target system's supported API, retaining source evidence, the stable capture/draft identity, authority flags, and a durable delivery receipt. Provide a preview, require explicit confirmation, use the target's native idempotency capability, and verify the returned object. Report uncertain delivery rather than silently retrying under a different identity. Make deliberate edits to already delivered items a separate operation.

A destination implements the same contract the two built-in ones use: a status that never reads another system's data, a canonical target, a preview that never contacts the destination, a confirmed submit that verifies what it created, and a durable receipt keyed by that target. `backend/destinations.py` is the registry; adding a destination means implementing that contract and listing it there. The existing routes, the popup, the review page and the automatic-delivery policy then work with it without further change.

Remote destinations need their own authentication, data-sharing consent, destination validation, and credential storage design. The built-in dashboard adapter intentionally remains loopback-only; do not relax its host checks to turn it into an arbitrary webhook client. The [GitHub destination](GITHUB_DESTINATION.md) is the reference for a remote one: a fixed host, a named repository, a credential that never leaves the adapter, and a destination that is chosen explicitly and frozen for the session.

## The GitHub issues destination

A reviewed draft can be delivered to a named GitHub repository as an issue. It is configured on the backend with `PANTHER_GITHUB_TOKEN` and `PANTHER_GITHUB_REPO` (or the equivalent files under `PANTHER_DATA_DIR`), the API host is fixed to `https://api.github.com`, and the credential never appears in a preview, a receipt, an export or a status report.

The routes mirror the local ticket service's, with the same preview-and-confirm rules: `GET /api/extension/integrations/github`, `POST /api/extension/integrations/github/preview/<id>` and `POST /api/extension/integrations/github/submit/<id>`. `GET /api/extension/integrations` lists every destination with its status.

Each issue carries a stable identity marker, `panther-capture-<recording-id>-<draft-id>`, and the review fence is the text of the body rather than only a label. The same identity is never created twice, and the same identity with different content is a conflict rather than an update. See [the GitHub destination](GITHUB_DESTINATION.md).

## Verification boundary

`tests/test_integrations.py` uses a fake loopback dashboard and temporary storage to test the adapter contract, including lost responses, deduplication, readback mismatches, redirects, and refused intake. A successful fixture run does not prove compatibility with a running dashboard version or acceptance of a real ticket. Record browser installation, actual captured evidence, the operator's delivery confirmation, and live readback separately when qualifying a deployment.
