<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#0969DA;vertical-align:-1px"></span> `iceberg_rest` · catalog · config schema v2 · connection test supported

**Notebook packages:** `pyiceberg[pyarrow,s3fs,gcsfs,adlfs,hf,rest-sigv4,gcp-auth,entra-auth]>=0.11`

::: details Iceberg REST Catalog configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `uri` | string | Yes |  | REST catalog base URI, e.g. https://catalog.internal/api/catalog |
| `warehouse` | string |  |  | Warehouse name/path if the server hosts several |
| `allow_insecure_transport` | boolean |  | `false` | Allow http:// endpoints to carry credentials — local development only |
| `auth.method` | `none`, `bearer_token`, `basic`, `oauth2_client_credentials`, `sigv4`, `google`, `entra` | Yes |  |  |
| `storage` |  |  |  |  |
| `runtime` |  |  |  |  |
| `access_delegation` | `none`, `vended_credentials`, `remote_signing`, `both` |  | `vended_credentials` | Catalog delegation mode. Guarded Run SQL supports none or R2 vended credentials. |
| `tls.ca_bundle` | string |  |  |  |
| `tls.client_certificate` | string |  |  |  |
| `tls.client_key` 🔒 | string |  |  |  |
| `rest.snapshot_loading_mode` | `all`, `refs` |  | `all` |  |
| `rest.metrics_reporting_enabled` | boolean |  | `true` |  |
| `rest.page_size` | integer |  |  |  |
| `rest.view_endpoints_supported` | boolean |  | `false` |  |
| `rest.scan_planning_mode` | `client`, `server` |  | `client` |  |
| `rest.namespace_separator` | string |  | `%1F` |  |
| `rest.table_cache_expire_after_write_ms` | integer |  | `300000` |  |
| `rest.table_cache_max_entries` | integer |  | `100` |  |
| `headers` | map&lt;string, string&gt; |  |  | Additional HTTP headers sent to the REST catalog |
| `extra_properties` |  |  |  |  |

**`auth.method: bearer_token`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.token` 🔒 | string | Yes |  |  |

**`auth.method: basic`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.username` | string | Yes |  |  |
| `auth.password` 🔒 | string | Yes |  |  |

**`auth.method: oauth2_client_credentials`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.token_endpoint` | string | Yes |  |  |
| `auth.client_id` | string | Yes |  |  |
| `auth.client_secret` 🔒 | string | Yes |  |  |
| `auth.scope` | string |  | `catalog` |  |
| `auth.refresh_margin_seconds` | integer |  | `60` |  |
| `auth.expires_in_seconds` | integer |  |  |  |

**`auth.method: sigv4`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.region` | string | Yes |  |  |
| `auth.signing_name` | string |  | `execute-api` |  |

**`auth.method: google`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.scopes` | string |  |  | Comma-separated OAuth scopes; uses Google ADC |
| `auth.credentials_json` 🔒 | string |  |  | Google service-account JSON |

**`auth.method: entra`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.scopes` | string |  |  | Comma-separated OAuth scopes; uses Azure credentials |
| `auth.managed_identity_client_id` | string |  |  |  |

:::
