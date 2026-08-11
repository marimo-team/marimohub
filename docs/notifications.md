---
description: Configure outbound email, Slack, and signed webhook notifications.
---

# Notifications

marimohub sends notifications after it stores the related change. It supports SMTP, Slack, and a signed JSON webhook. Enable one backend or several backends.

## Configure notifications

1. Set `MARIMOHUB_NOTIFY_BACKENDS` to a comma-separated list. Use `smtp`, `slack`, or `webhook`.
2. Set the required variables for each enabled backend.
3. Set `MARIMOHUB_NOTIFY_KINDS` if you need to limit the enabled notification kinds.

This example enables email and the generic webhook:

```dotenv
MARIMOHUB_NOTIFY_BACKENDS=smtp,webhook
MARIMOHUB_NOTIFY_SMTP_URL=smtps://user:password@smtp.example.com:465
MARIMOHUB_NOTIFY_SMTP_FROM=marimohub <hub@example.com>
MARIMOHUB_NOTIFY_WEBHOOK_URL=https://events.example.com/marimohub
MARIMOHUB_NOTIFY_WEBHOOK_SECRET=replace-with-a-secret
```

Backend names are case-insensitive. marimohub ignores duplicate names. Leave `MARIMOHUB_NOTIFY_BACKENDS` empty to disable all notifications.

## Notification kinds

| Kind               | Trigger                                                      | Recipient                             |
| ------------------ | ------------------------------------------------------------ | ------------------------------------- |
| `member.invited`   | A manager adds an email address that has no identity record. | The invited email address.            |
| `member.added`     | A manager adds a known user.                                 | The user from the identity directory. |
| `session.takeover` | An editor takes over an exclusive editor session.            | The displaced editor.                 |

All listed kinds are enabled by default. `MARIMOHUB_NOTIFY_KINDS` is an exact, comma-separated allowlist. An unknown kind causes a startup configuration error. A blank allowlist enables the default set.

## Delivery behavior

- The API stores the membership or session change before it schedules delivery.
- A rendering or delivery failure does not change the API response.
- marimohub sends each notification to every configured backend.
- One failed backend does not stop another backend.
- SMTP makes one delivery attempt. The HTTP adapters allow one request retry and use a 10-second timeout.
- There is no durable retry queue. The system drops a notification after all delivery attempts fail.
- Use `dedupe_key` to reject duplicate deliveries. Member additions use a unique mutation ID. Session takeovers use the takeover ID.

If rendering fails, marimohub writes `notification_delivery_failed` to the operational log. It also writes this event when every configured backend fails.

The metrics port receives `notify.delivered`, `notify.skipped`, and `notify.deliver_failed` for each backend. All three metrics include `adapter` and `kind` tags.

## SMTP

Set these variables when you enable `smtp`:

| Variable                         | Use                                                           |
| -------------------------------- | ------------------------------------------------------------- |
| `MARIMOHUB_NOTIFY_SMTP_URL`      | Required connection URL. It must use `smtp://` or `smtps://`. |
| `MARIMOHUB_NOTIFY_SMTP_FROM`     | Required sender address.                                      |
| `MARIMOHUB_NOTIFY_SMTP_ADMIN_TO` | Optional comma-separated fallback recipients.                 |

The adapter sends plain-text email. It rejects line breaks in sender, recipient, recipient name, and subject fields.

User notifications use their resolved email addresses. If no user address exists, the adapter uses `MARIMOHUB_NOTIFY_SMTP_ADMIN_TO`. It skips delivery if neither list has an address.

## Slack

Set `MARIMOHUB_NOTIFY_SLACK_WEBHOOK_URL` when you enable `slack`. The value is required and must be an HTTPS incoming webhook URL.

The configured channel receives every enabled notification. Slack delivery does not use the notification recipient list. The adapter escapes `&`, `<`, and `>` in message text. It also disables link and media previews.

## Generic webhook

Set both variables when you enable `webhook`:

| Variable                          | Use                               |
| --------------------------------- | --------------------------------- |
| `MARIMOHUB_NOTIFY_WEBHOOK_URL`    | Required HTTPS destination.       |
| `MARIMOHUB_NOTIFY_WEBHOOK_SECRET` | Required HMAC-SHA256 signing key. |

The destination receives the complete notification as JSON. Webhook delivery does not use the recipient list for routing. A payload has this shape:

```json
{
	"kind": "member.invited",
	"severity": "info",
	"title": "You were invited to Forecasts",
	"body": "Owner invited you to Forecasts as editor.",
	"link": "https://hub.example.com/projects/project_01",
	"recipients": [{ "email": "member@example.com" }],
	"context": { "pid": "project_01", "role": "editor" },
	"dedupe_key": "member.invited:snap-0123456789abcdef"
}
```

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

Do not expose these settings to project users. User-supplied destinations need SSRF controls. Such controls must reject private, loopback, link-local, metadata, and CGNAT addresses. They must also reject redirects and enforce request limits.
