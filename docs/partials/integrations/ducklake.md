<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#FFF000;vertical-align:-1px"></span> `ducklake` · database · config schema v1

::: details DuckLake configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `metadata.type` | `duckdb` | Yes |  | Metadata catalog format. Only DuckDB catalog files are supported. |
| `metadata.url` | string | Yes |  | Exact HTTPS URL of one immutable DuckLake metadata file |
| `metadata.auth.method` | `none`, `bearer_token`, `basic` | Yes |  | How the hub authenticates to the metadata URL. Never forwarded to S3 requests. |
| `metadata.allow_non_database_suffix` | boolean |  | `false` | Accept a metadata URL that does not end in `.ducklake` or `.duckdb`. |
| `storage.scheme` | `s3` | Yes |  | Data-file storage scheme. Only S3-compatible storage is supported. |
| `storage.endpoint` | string | Yes |  | Origin-only HTTPS S3 endpoint, e.g. `https://s3.us-east-1.amazonaws.com`. |
| `storage.region` | string | Yes |  | AWS region used to sign S3 requests, e.g. `us-east-1`. |
| `storage.force_virtual_addressing` | boolean |  | `true` | Address buckets as `{bucket}.{endpoint}` (virtual-hosted style) instead of `{endpoint}/{bucket}` (path style). |
| `storage.credentials.method` | `static` | Yes |  | Credential source. Only static keys are supported. |
| `storage.credentials.access_key_id` 🔒 | string | Yes |  | AWS access key ID. Held by the hub broker; never sent to the notebook worker. |
| `storage.credentials.secret_access_key` 🔒 | string | Yes |  | AWS secret access key. Held by the hub broker; never sent to the notebook worker. |
| `storage.credentials.session_token` 🔒 | string |  |  | AWS session token for temporary credentials. |
| `storage.broker_read_locations` | object[] | Yes |  | Bucket prefixes the broker may read data files from. Requests outside these locations are rejected. |
| `storage.broker_read_locations[].bucket` | string | Yes |  |  |
| `storage.broker_read_locations[].prefix` | string | Yes |  |  |
| `snapshot.version` | integer |  |  | Read this DuckLake snapshot version instead of the latest snapshot. |
| `snapshot.timestamp` | string |  |  | Read the snapshot current at this RFC 3339 timestamp instead of the latest. |

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
