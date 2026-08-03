<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;padding:3px;border-radius:6px;background:var(--vp-c-default-soft);vertical-align:-7px"><svg role="img" aria-label="MongoDB logo" viewBox="0 0 24 24" width="18" height="18" fill="#47A248"><path d="M17.193 9.555c-1.264-5.58-4.252-7.414-4.573-8.115-.28-.394-.53-.954-.735-1.44-.036.495-.055.685-.523 1.184-.723.566-4.438 3.682-4.74 10.02-.282 5.912 4.27 9.435 4.888 9.884l.07.05A73.49 73.49 0 0111.91 24h.481c.114-1.032.284-2.056.51-3.07.417-.296.604-.463.85-.693a11.342 11.342 0 003.639-8.464c.01-.814-.103-1.662-.197-2.218zm-5.336 8.195s0-8.291.275-8.29c.213 0 .49 10.695.49 10.695-.381-.045-.765-1.76-.765-2.405z"/></svg></span> `mongodb` · database · config schema v1

**Notebook packages:** `pymongo>=4.9`

::: details MongoDB configuration reference

Fields marked 🔒 are secret: encrypted at rest and write-only after save.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scheme` | `mongodb+srv`, `mongodb` |  | `mongodb+srv` |  |
| `host` | string | Yes |  | Cluster hostname, e.g. cluster0.abcde.mongodb.net |
| `port` | integer |  | `27017` | Ignored for mongodb+srv |
| `database` | string |  |  | Default database for `client.get_database()` |
| `auth.method` | `password`, `none` |  | `none` |  |
| `tls.mode` | `enabled`, `disabled` |  | `enabled` |  |

**`auth.method: password`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.username` | string | Yes |  |  |
| `auth.password` 🔒 | string | Yes |  |  |
| `auth.auth_source` | string |  | `admin` |  |

**`tls.mode: enabled`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tls.ca_bundle` | string |  |  | PEM CA bundle to trust, written into the session |
| `tls.ca_path` | string |  |  | Absolute path to a CA bundle the runtime already ships (default /etc/ssl/certs/ca-certificates.crt) |

:::
