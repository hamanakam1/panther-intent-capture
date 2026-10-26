# The GitHub issues destination

Panther can deliver a reviewed draft to a GitHub repository as an issue. This
is its first **remote** destination, and it is deliberately narrow.

It is off unless it is configured. It has its own credential. It is never
relaxed into a general webhook client, and the local ticket service adapter
stays loopback-only.

## What it does

- Takes a reviewed draft and maps it to a GitHub issue: the title, a bounded
  body, and review labels.
- Puts the **review fence in the body text**: every issue begins with
  "not authorized for autonomous execution". The `no-auto` label is a
  convenience; the fence is the text.
- Carries a stable identity for each draft of each capture, so the same
  draft is never created twice.
- Verifies the created issue by reading it back before reporting delivery.
- Keeps a durable local receipt, exactly like the other destinations.

## Configuring it

The destination is configured on the backend, not in the extension.

| Setting | Environment variable | File under `PANTHER_DATA_DIR` |
|---|---|---|
| Credential | `PANTHER_GITHUB_TOKEN` | `github/token` |
| Repository | `PANTHER_GITHUB_REPO` | `github/repo` |

The repository is `owner/name`. The file form is only used when the file is
readable by its owner alone; a credential anyone else can read is ignored.

The credential is read only by the adapter. It never appears in a preview, a
receipt, an export, a status report or a log. The status report says only
whether a credential is present.

The API host is fixed to `https://api.github.com`. It is not configurable,
because a configurable host would turn this into a client for whatever the
token can reach. GitHub Enterprise would need its own explicit design.

## Idempotency

GitHub's issue API has no idempotency key, so Panther uses two mechanisms:

1. **A local receipt** keyed by the destination and the draft identity. This
   is the primary mechanism: the same draft is never submitted twice, and a
   retry reuses the same identity.
2. **An identity marker in the issue body.** Before creating anything,
   Panther reads the repository's recent issues and looks for that marker. An
   issue that already carries it is reused rather than duplicated.

The marker is `panther-capture-<recording-id>-<draft-id>`. It is the
identity of one draft of one capture.

If the same identity is submitted with **different** content, the result is a
`conflict`, not an update. An existing issue is never silently rewritten.
Making a deliberate edit to a delivered issue is a separate operation that
Panther does not perform.

## Delivery outcomes

| State | Meaning |
|---|---|
| `delivered` | The issue was created or found, and the readback matched. |
| `pending` | A request or the readback was uncertain. Retry with the same identity. |
| `refused` | GitHub refused the creation, for example because the token lacks permission. |
| `conflict` | This identity was already submitted with different content. |

## Consent

Automatic delivery to a remote destination is a different decision from
delivery to a loopback one, so it is chosen explicitly.

The popup lists every destination the backend offers. One is selected, and
its canonical target is **frozen for the session** the moment consent is
given. A later change to the configuration does not retarget a capture: the
admitted job notices that the configured destination no longer matches the
consented one, and blocks itself instead of delivering somewhere else.

The review page has the same choice for manual delivery, and a manual
delivery is always a preview followed by an explicit confirmation of that
exact payload.

## Routes

| Method and route | Purpose |
|---|---|
| `GET /api/extension/integrations` | Every destination with its status. |
| `GET /api/extension/integrations/github` | The GitHub destination's status. |
| `POST /api/extension/integrations/github/preview/<id>` | Build the exact issue without contacting GitHub. |
| `POST /api/extension/integrations/github/submit/<id>` | Submit one confirmed, previewed draft and verify it. |

The routes are the same shape as the local ticket service's, and the same
rules apply: a preview that does not match the confirmed payload is refused,
and a delivery is only reported as successful after an independent readback.

## What is not established

- No live delivery to github.com was performed. The adapter's behaviour is
  covered by a synthetic GitHub API, not by a real repository.
- The review fence is text in the body plus a label. It is not a GitHub
  permission: a repository that allows automation to act on issues can still
  act on them. Treat the fence as a review instruction, not as access
  control.
