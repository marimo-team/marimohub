---
description: Configure project-scoped Slack and signed-webhook alerts.
---

# Project alerts

Project alerts let a project manager send selected operational and access events to a
project-specific Slack channel or signed HTTPS webhook. They are separate from the
deployment-wide notification backends in [Notifications](./notifications.md). Project-only
events never flow to `MARIMOHUB_NOTIFY_*` destinations.

## Enable the feature

Project alerts are available on the Node server only. Configure the same generated 32-byte KEK
on every replica, then enable the feature:

```dotenv
MARIMOHUB_SECRETS_KEK=<64 hex digits or canonical base64 for 32 random bytes>
MARIMOHUB_PROJECT_ALERTS=on
```

The server refuses to start if project alerts are on and the KEK is absent or invalid. Roll out
the code with the feature off, configure the KEK on all upgraded replicas, and then turn the
feature on. Cloudflare Workers report the capability as unavailable because that runtime does
not use the repository's DNS-pinned Node egress transport.

## Destination workflow

A manager opens **Project alerts** from the project header and adds a Slack incoming webhook or
a generic webhook. A project can store at most 10 destinations. New destinations select every
available event by default, but the manager can choose an exact set.

Every new destination starts disabled. The manager must send a successful test before the
destination can be enabled. Replacing a URL or signing secret atomically disables it and clears
verification. Renaming it or changing its selected events preserves verification. Stored URLs
and secrets are never returned to the browser; the UI shows only the endpoint hostname and
configured flags.

API clients follow the same create, test, then enable sequence. Save the `ETag` returned by
create and send it as `If-Match` when testing or updating the destination. A test sends a real
external message and requires an `Idempotency-Key`. Reusing a key from a completed test returns
the original redacted destination without sending another message. A concurrent, failed, or
ambiguous attempt returns `409 CONFLICT` on reuse because the server reserves the key before
delivery. Use a new key only when deliberately starting another test. Use the returned `ETag`
when enabling the verified destination. The CLI also treats a test as a confirming operation and
requires `--yes` in non-interactive use.

## Alert catalog

| Kind                  | Trigger                                                         | Severity |
| --------------------- | --------------------------------------------------------------- | -------- |
| `member.invited`      | A pending email invitation is created.                          | Info     |
| `member.added`        | A known user is added.                                          | Info     |
| `member.role_changed` | A member role changes.                                          | Warning  |
| `member.removed`      | A member is removed.                                            | Warning  |
| `session.takeover`    | An exclusive editor takeover succeeds.                          | Warning  |
| `notebook.deleted`    | A notebook is soft-deleted.                                     | Warning  |
| `project.deleted`     | A project is soft-deleted.                                      | Warning  |
| `app.start_failed`    | Shared-app provisioning fails after its session record exists.  | Error    |
| `app.unavailable`     | Maintenance finds that a running shared app lost its sandbox.   | Error    |
| `sync.failed`         | An authenticated git-sync push fails validation or persistence. | Error    |

`app.unavailable` can arrive up to one five-minute maintenance interval after the sandbox
disappears. It is emitted only for the state transition that marks the session failed. Normal
app stops do not create it.

## Delivery and payloads

Slack gets one attempt. A generic webhook gets one retry after a transport failure, HTTP 408,
HTTP 429, or a 5xx response. A 429 delays that retry by 1–60 seconds; a `Retry-After` value is
clamped to that range. Other retries are immediate. Other 4xx responses are not retried. Webhooks receive the same
`schema_version: 1` notification envelope documented in
[Notifications](./notifications.md). Only the destination's selected kinds are sent. Error
events contain a sanitized error code, not provider messages, URLs, credentials, or secrets.
Project alert webhooks use the same `X-Marimohub-Signature` header and HMAC construction as
deployment-wide [generic webhooks](./notifications.md#generic-webhook).

Delivery is best-effort. It begins only after the related storage mutation commits, and a
delivery failure never changes the API response. There is no durable queue, history, digest, or
user-visible retry. Webhook consumers must deduplicate on `dedupe_key`.

Operational logs use `project_alert_delivery_failed` and `project_alert_delivery_partial`.
Metrics use `project_alert.delivered`, `project_alert.skipped`, and
`project_alert.deliver_failed`, tagged only by adapter type and notification kind. Each project
can schedule at most 100 alert events per minute per server process. Excess events are skipped
and increment `project_alert.rate_limited`; another project's budget is unaffected.

## Egress security

All endpoints must use HTTPS and cannot contain user information. Before every request, the
Node transport resolves the hostname, rejects any private, loopback, link-local, reserved,
metadata, or CGNAT address, and pins the connection to the validated DNS answers. Redirects are
not followed. Requests have a 10-second deadline and a 16 KiB response cap. Each user can
attempt 10 destination tests in a rolling minute. Further attempts return
`429 RESOURCE_EXHAUSTED` without sending a message.

Managers are trusted to disclose project metadata to destinations they configure. URLs and
HMAC secrets are encrypted in `projects/{pid}/alerts.json` with path-bound AES-256-GCM under
`MARIMOHUB_SECRETS_KEK`.
