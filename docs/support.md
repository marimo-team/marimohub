---
description: Configure support links and problem reports with session diagnostics.
---

# Support

**Report a problem** opens a diagnostics preview from the Help menu, notebook error panels, and client error fallback.
Users can copy the report or send it through the configured destination.

## Configuration

```dotenv
MARIMOHUB_THEME_SUPPORT_URL=https://support.example.com/new
MARIMOHUB_THEME_DOCS_URL=https://docs.example.com
```

The support URL supplies **Get help** links and the sign-in page's **Contact your administrator** link.
Both URLs accept HTTPS URLs or root-relative paths. See [Theming](./theming.md).

`MARIMOHUB_SUPPORT_REPORTS` controls report delivery. The default is `off`.
When it is `off`, users can copy diagnostics, and the **Open support portal** link opens the support URL when one is set.
The link never contains diagnostics. Users paste the copied report into the portal.
When it is `on`, users can send reports to deployment notification destinations.
`on` requires a notification backend that accepts `support.request`. SMTP also needs `MARIMOHUB_NOTIFY_SMTP_ADMIN_TO`.
`on` without such a destination causes a startup error.

### Notifications

```dotenv
MARIMOHUB_SUPPORT_REPORTS=on
MARIMOHUB_NOTIFY_BACKENDS=slack
MARIMOHUB_NOTIFY_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/secret
MARIMOHUB_NOTIFY_SLACK_KINDS=support.request,session.takeover
```

`support.request` is a broadcast notification. SMTP sends it to administrator recipients.
The notification title names the reporter's email. The body shows the message and the diagnostics in separate labeled sections.
Slack includes readable diagnostics. Signed webhooks include diagnostics in the notification data.
Project alert destinations never receive support reports. See [Notifications](./notifications.md).

The API waits for delivery. Partial success means at least one destination accepted the report.
If all destinations fail or skip delivery, users can copy or retry the report.
There is no durable retry queue.

## Diagnostics and access

| Context                 | Included fields                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Every report            | Reporter ID and email, message, page URL, hub version, browser, viewport, timestamp.                  |
| Session, when available | Session, project, and notebook IDs, runtime versions, and the fields below that the reporter can see. |
| Client error fallback   | Caught error message, without a stack trace.                                                          |

The server resolves session fields from stored records and checks session access.
Session fields follow the same redaction as the session API.
The source-version ID and compute profile are omitted for app users.
The stored error appears only to users who can attach to the session. App users get a generic error.
The sandbox ID appears only to users who can attach and are not app users.
The server ignores client-supplied reporter, hub-version, and sandbox fields.
Page URLs exclude credentials, query parameters, and fragments.
Reports collect no notebook content, cell outputs, environment variables, integration configuration, or logs.
Users must review their message and diagnostics before sharing.
If the API is unavailable, users can still copy local page and error details.

Signed-in users, including app users, can request support within their credential permissions:

- `POST /api/v1/support/diagnostics` returns a preview.
- `POST /api/v1/support/requests` sends a report. It returns 404 when `MARIMOHUB_SUPPORT_REPORTS` is `off`.

Messages have a 2,000-character limit.
Each reporter can send five support requests per ten minutes. Failed deliveries count toward this limit.
A reporter over the limit gets a 429 response.
Delivery to multiple destinations and internal retries consume one request from the budget.
Requests that fail validation or authorization do not consume the budget.
The shared notification budget also limits each reporter to 20 changes per minute. Both budgets apply per API instance.

Successful or partial delivery records a `support.request` audit event with the reporter ID, request ID, and outcome.
The audit event excludes the message and diagnostics.
