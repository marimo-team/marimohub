<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;padding:3px;border-radius:6px;background:var(--vp-c-default-soft);vertical-align:-7px"><svg role="img" aria-label="ClickHouse logo" viewBox="0 0 24 24" width="18" height="18" fill="#FFCC01"><path d="M21.333 10H24v4h-2.667ZM16 1.335h2.667v21.33H16Zm-5.333 0h2.666v21.33h-2.666ZM0 22.665V1.335h2.667v21.33zm5.333-21.33H8v21.33H5.333Z"/></svg></span> `clickhouse` · database · config schema v1 · connection test supported

**Notebook packages:** `clickhouse-connect>=0.8`

::: details ClickHouse configuration reference

Fields marked 🔒 are secret: encrypted at rest and write-only after save.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `host` | string | Yes |  | Server hostname, e.g. abc123.us-east-1.aws.clickhouse.cloud |
| `port` | integer |  | `8443` | HTTP interface port |
| `secure` | boolean |  | `true` | Use HTTPS for the HTTP interface |
| `verify` | boolean |  | `true` | Verify the server certificate (clickhouse-connect `verify`) |
| `database` | string |  | `default` |  |
| `username` | string |  | `default` |  |
| `password` 🔒 | string |  |  | Omit for a user with no password |

:::
