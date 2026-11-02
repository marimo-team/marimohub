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

`MARIMOHUB_SUPPORT_MODE` selects report delivery:

| Mode       | Behavior                                                     | Requirement                                                                                 |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `notifier` | Sends reports to deployment notification destinations.       | A backend that accepts `support.request`. SMTP also needs `MARIMOHUB_NOTIFY_SMTP_ADMIN_TO`. |
| `url`      | Opens the support portal with diagnostics.                   | `MARIMOHUB_THEME_SUPPORT_URL`.                                                              |
| `off`      | Offers copyable diagnostics. Support links remain available. | None.                                                                                       |

The default is the first available mode in table order.
An explicit mode without its required destination causes a startup error.

### Notifications

```dotenv
MARIMOHUB_SUPPORT_MODE=notifier
MARIMOHUB_NOTIFY_BACKENDS=slack
MARIMOHUB_NOTIFY_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/secret
MARIMOHUB_NOTIFY_SLACK_KINDS=support.request,session.takeover
```

`support.request` is a broadcast notification. SMTP sends it to administrator recipients.
Slack includes readable diagnostics. Signed webhooks include diagnostics in the notification data.
Project alert destinations never receive support reports. See [Notifications](./notifications.md).

The API waits for delivery. Partial success means at least one destination accepted the report.
If all destinations fail or skip delivery, users can copy or retry the report.
There is no durable retry queue.

### External portal

```dotenv
MARIMOHUB_SUPPORT_MODE=url
MARIMOHUB_THEME_SUPPORT_URL=https://support.example.com/new?category=hub
```

The link adds a `diagnostics` query parameter containing base64-encoded UTF-8 JSON, up to 4 KiB after encoding.
Existing query parameters remain intact. Larger reports use a plain portal link with instructions to copy diagnostics.
Portals must accept this parameter to prefill requests. Users can copy reports into other portals.

The parameter includes the reporter's email, message, and diagnostics. Base64 encoding does not encrypt this data.
Browser history and access logs on portal servers or proxies can retain the full URL.
Administrators must assess this exposure before they enable `url` mode.
`notifier` mode sends reports without URL parameters. `off` mode lets users copy reports manually into a trusted destination.

## Diagnostics and access

| Context                 | Included fields                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| Every report            | Reporter ID and email, message, page URL, hub version, browser, viewport, timestamp.                          |
| Session, when available | Session, project, notebook, source-version, and sandbox IDs, runtime versions, compute profile, stored error. |
| Client error fallback   | Caught error message, without a stack trace.                                                                  |

The server resolves session fields from stored records and checks session access.
It ignores client-supplied reporter, hub-version, and sandbox fields.
Page URLs exclude credentials, query parameters, and fragments.
Reports collect no notebook content, cell outputs, environment variables, integration configuration, or logs.
Users must review their message and diagnostics before sharing.
If the API is unavailable, users can still copy local page and error details.

Signed-in users, including app users, can request support within their credential permissions:

- `POST /api/v1/support/diagnostics` returns a preview.
- `POST /api/v1/support/requests` sends a report in notifier mode.

Messages have a 2,000-character limit.
Each reporter can send five support requests per ten minutes. Failed deliveries count toward this limit.
Delivery to multiple destinations and internal retries consume one request from the budget.
Requests that fail validation or authorization do not consume the budget.
The shared notification budget also limits each reporter to 20 changes per minute. Both budgets apply per API instance.

Successful or partial delivery records a `support.request` audit event with the reporter ID, request ID, and outcome.
The audit event excludes the message and diagnostics.
