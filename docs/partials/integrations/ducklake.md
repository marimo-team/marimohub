<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#FFF000;vertical-align:-1px"></span> `ducklake` · database · config schema v1

::: details DuckLake configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `metadata.type` | `duckdb` | Yes |  |  |
| `metadata.url` | string | Yes |  | Exact HTTPS URL of one immutable DuckLake metadata file |
| `metadata.auth.method` | `none`, `bearer_token`, `basic` | Yes |  |  |
| `metadata.allow_non_database_suffix` | boolean |  | `false` |  |
| `storage.scheme` | `s3` | Yes |  |  |
| `storage.endpoint` | string | Yes |  |  |
| `storage.region` | string | Yes |  |  |
| `storage.force_virtual_addressing` | boolean |  | `true` |  |
| `storage.credentials.method` | `static` | Yes |  |  |
| `storage.credentials.access_key_id` 🔒 | string | Yes |  |  |
| `storage.credentials.secret_access_key` 🔒 | string | Yes |  |  |
| `storage.credentials.session_token` 🔒 | string |  |  |  |
| `storage.broker_read_locations` | object[] | Yes |  |  |
| `storage.broker_read_locations[].bucket` | string | Yes |  |  |
| `storage.broker_read_locations[].prefix` | string | Yes |  |  |
| `snapshot.version` | integer |  |  |  |
| `snapshot.timestamp` | string |  |  |  |

**`metadata.auth.method: bearer_token`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `metadata.auth.token` 🔒 | string | Yes |  |  |

**`metadata.auth.method: basic`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `metadata.auth.username` | string | Yes |  |  |
| `metadata.auth.password` 🔒 | string | Yes |  |  |

:::
