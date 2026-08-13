---
description: Configure outbound email, Slack, and signed webhook notifications.
---

# Notifications

marimohub sends notifications after it stores the related change. It supports SMTP, Slack, and a signed JSON webhook. You can enable one backend or several backends.

These are deployment-wide operator destinations. For manager-configured destinations that are
limited to one project, see [Project alerts](./project-alerts.md).

## Configure notifications

1. Set `MARIMOHUB_NOTIFY_BACKENDS` to a comma-separated list. Use `smtp`, `slack`, or `webhook`.
2. Set the required variables for each enabled backend.
3. Set the global or per-backend kind allowlists.

Slack and webhook targets resolve through a guarded transport. Private, loopback, link-local, and
reserved addresses are blocked by default. Set `MARIMOHUB_NOTIFY_ALLOW_PRIVATE=true` only when an
operator-managed destination intentionally runs on an internal network.

This example sends member changes by email and session takeovers to Slack:

```dotenv
MARIMOHUB_NOTIFY_BACKENDS=smtp,slack
MARIMOHUB_NOTIFY_SMTP_URL=smtps://user:password@smtp.example.com:465
MARIMOHUB_NOTIFY_SMTP_FROM=marimohub <hub@example.com>
MARIMOHUB_NOTIFY_SMTP_KINDS=member.invited,member.added
MARIMOHUB_NOTIFY_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/secret
MARIMOHUB_NOTIFY_SLACK_KINDS=session.takeover
```

Backend names are case-insensitive. marimohub ignores duplicate names. Leave `MARIMOHUB_NOTIFY_BACKENDS` empty to disable all notifications.

## Route kinds to backends

These notification kinds are available:

| Kind               | Trigger                                                      | Available audience      |
| ------------------ | ------------------------------------------------------------ | ----------------------- |
| `member.invited`   | A manager adds an email address that has no identity record. | `personal`              |
| `member.added`     | A manager adds a known user.                                 | `personal`              |
| `session.takeover` | An editor takes over an exclusive editor session.            | `personal`, `broadcast` |

`MARIMOHUB_NOTIFY_KINDS` is the default allowlist for all backends. A blank value enables all listed kinds. Set it to `none` to disable all kinds. This global off switch takes precedence over per-backend values.

Each backend can replace the global allowlist:

| Variable                         | Backend |
| -------------------------------- | ------- |
| `MARIMOHUB_NOTIFY_SMTP_KINDS`    | SMTP    |
| `MARIMOHUB_NOTIFY_SLACK_KINDS`   | Slack   |
| `MARIMOHUB_NOTIFY_WEBHOOK_KINDS` | Webhook |

If a per-backend variable is unset or blank, it inherits `MARIMOHUB_NOTIFY_KINDS`. Set a per-backend variable to `none` to disable that backend. Each value is an exact, comma-separated allowlist. An unknown kind causes a startup configuration error.

The kind filter does not convert one audience into another. For example, Slack still skips `member.invited` because that kind has no broadcast variant.

## Audiences

A `personal` notification uses second-person text and resolved user recipients. A `broadcast` notification uses third-person text for an operator-managed destination.

| Backend | Personal delivery                                | Broadcast delivery                                |
| ------- | ------------------------------------------------ | ------------------------------------------------- |
| SMTP    | Sends to resolved notification recipients.       | Sends to `MARIMOHUB_NOTIFY_SMTP_ADMIN_TO`.        |
| Slack   | Skips.                                           | Sends to the configured incoming webhook.         |
| Webhook | Sends the complete personal notification object. | Sends the complete broadcast notification object. |

A session takeover creates one personal variant and one broadcast variant. The variants have different copy and different `dedupe_key` values. When `session.takeover` is enabled, a generic webhook receives both variants.

SMTP does not send personal content to administrator addresses. If a personal recipient cannot be resolved, SMTP skips that variant.

## Delivery behavior

- The API stores the membership or session change before it schedules delivery.
- A render or delivery failure does not change the API response.
- One failed backend does not stop another backend.
- SMTP and Slack make one delivery attempt.
- The generic webhook permits one request retry.
- Both HTTP adapters use a 10-second timeout.
- There is no durable retry queue. The system drops a notification after all delivery attempts fail.
- Use `dedupe_key` to reject duplicate webhook deliveries.

Member notifications use the immutable membership mutation ID in `dedupe_key`. Session takeovers use the takeover ID and audience. Therefore, a removed and re-added member gets a new key.

On Cloudflare Workers, marimohub registers delivery with the request execution context. This keeps delivery alive after the API response. It does not make the work durable. When delivery guarantees are required, use a webhook receiver with durable processing.

If rendering fails, marimohub writes `notification_delivery_failed` to the operational log. It writes the same event when all delivery attempts fail. If only some variants or backends succeed, it writes `notification_delivery_partial` at warning level.

The metrics port receives `notify.delivered`, `notify.skipped`, and `notify.deliver_failed` for each backend. All three metrics include `adapter` and `kind` tags.

## SMTP

When you enable `smtp`, set these variables:

| Variable                         | Use                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `MARIMOHUB_NOTIFY_SMTP_URL`      | Required connection URL. It must include a hostname and use `smtp://` or `smtps://`. |
| `MARIMOHUB_NOTIFY_SMTP_FROM`     | Required sender address.                                                             |
| `MARIMOHUB_NOTIFY_SMTP_ADMIN_TO` | Optional comma-separated recipients for broadcast notifications.                     |
| `MARIMOHUB_NOTIFY_SMTP_KINDS`    | Optional exact kind allowlist for SMTP.                                              |

The adapter sends plain-text email. It rejects line breaks in sender, recipient, recipient name, and subject fields.

## Slack

When you enable `slack`, set `MARIMOHUB_NOTIFY_SLACK_WEBHOOK_URL`. The value is required and must be an HTTPS incoming webhook URL. Use `MARIMOHUB_NOTIFY_SLACK_KINDS` to set an exact kind allowlist for Slack.

Slack sends broadcast variants only. The adapter escapes `&`, `<`, and `>` in message text. It also disables link and media previews.

## Generic webhook

When you enable `webhook`, set these variables:

| Variable                          | Use                                         |
| --------------------------------- | ------------------------------------------- |
| `MARIMOHUB_NOTIFY_WEBHOOK_URL`    | Required HTTPS destination.                 |
| `MARIMOHUB_NOTIFY_WEBHOOK_SECRET` | Required HMAC-SHA256 signing key.           |
| `MARIMOHUB_NOTIFY_WEBHOOK_KINDS`  | Optional exact kind allowlist for webhooks. |

The destination receives the complete notification as JSON. A payload has this shape:

```json
{
	"schema_version": 1,
	"kind": "member.invited",
	"severity": "info",
	"audience": "personal",
	"title": "You were invited to Forecasts",
	"body": "Owner invited you to Forecasts as editor.",
	"link": "https://hub.example.com/projects/proj-0123456789abcdef",
	"recipients": [{ "email": "member@example.com" }],
	"context": { "pid": "proj-0123456789abcdef", "role": "editor" },
	"data": {
		"project_id": "proj-0123456789abcdef",
		"project_name": "Forecasts",
		"role": "editor",
		"member_email": "member@example.com",
		"actor_user_id": "owner-123"
	},
	"dedupe_key": "member.invited:snap-0123456789abcdef:personal"
}
```

The top-level `kind` discriminates the `data` object. Version 1 has these data fields:

| Kind               | Data fields                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `member.invited`   | `project_id`, `project_name`, `role`, `member_email`, `actor_user_id`                                              |
| `member.added`     | `project_id`, `project_name`, `role`, `member_user_id`, `actor_user_id`                                            |
| `session.takeover` | `project_id`, `project_name`, `notebook_id`, `notebook_title`, `takeover_id`, `actor_user_id`, `displaced_user_id` |

Use `schema_version` before you parse the payload. The `context` field remains for compatibility. New consumers must use `data` for kind-specific values.

The request includes this signature header:

```text
X-Marimohub-Signature: t=<unix-seconds>,v1=<hex-hmac>
```

The signed value is `<unix-seconds>.<raw-request-body>`. Use the raw body for signature verification. Do not parse and serialize it before verification.

This Node.js example rejects invalid signatures and requests older than five minutes:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyMarimohubWebhook(rawBody, header, secret) {
	const fields = Object.fromEntries(header.split(',').map((part) => part.split('=')));
	const timestamp = Number(fields.t);
	if (!Number.isFinite(timestamp)) return false;
	if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

	const actual = Buffer.from(fields.v1 ?? '', 'hex');
	const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

## Security boundary

Only deployment operators set Slack and webhook destinations. Store SMTP credentials and webhook secrets as deployment secrets. Adapter errors do not include destination URLs or credentials.

Do not expose these deployment settings to project users. Project-scoped destinations use the
separate guarded transport described in [Project alerts](./project-alerts.md).
