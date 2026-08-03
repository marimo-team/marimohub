<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#0969DA;vertical-align:-1px"></span> `iceberg_rest` · catalog · config schema v2 · connection test supported

**Notebook packages:** `pyiceberg[pyarrow,s3fs,gcsfs,adlfs,hf,rest-sigv4,gcp-auth,entra-auth]>=0.11`

::: details Iceberg REST Catalog configuration reference

Fields marked 🔒 are secret: encrypted at rest and write-only after save.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `uri` | string | Yes |  | REST catalog base URI, e.g. https://catalog.internal/api/catalog |
| `warehouse` | string |  |  | Warehouse name/path if the server hosts several |
| `allow_insecure_transport` | boolean |  | `false` | Allow http:// endpoints to carry credentials — local development only |
| `auth.method` | `none`, `bearer_token`, `basic`, `oauth2_client_credentials`, `sigv4`, `google`, `entra` | Yes |  |  |
| `storage.scheme` | `catalog`, `s3`, `gcs`, `adls`, `hdfs`, `hugging_face` |  | `catalog` |  |
| `runtime.max_workers` | integer |  |  |  |
| `runtime.legacy_current_snapshot_id` | boolean |  |  |  |
| `runtime.downcast_ns_timestamp_to_us_on_write` | boolean |  |  |  |
| `runtime.pyarrow_use_large_types_on_read` | boolean |  |  |  |
| `access_delegation` | `none`, `vended_credentials`, `remote_signing`, `both` |  | `vended_credentials` |  |
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
| `extra_properties` | map&lt;string, string&gt; |  |  | Raw PyIceberg catalog properties not represented by typed fields |

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

**`storage.scheme: s3`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.region` | string |  |  |  |
| `storage.endpoint` | string |  |  |  |
| `storage.credentials.method` | `ambient`, `static`, `profile` |  | `ambient` |  |
| `storage.role_arn` | string |  |  |  |
| `storage.role_session_name` | string |  |  |  |
| `storage.signer` | string |  |  |  |
| `storage.signer_uri` | string |  |  |  |
| `storage.signer_endpoint` | string |  |  |  |
| `storage.resolve_region` | boolean |  | `false` |  |
| `storage.proxy_uri` | string |  |  |  |
| `storage.connect_timeout` | number |  |  |  |
| `storage.request_timeout` | number |  |  |  |
| `storage.force_virtual_addressing` | boolean |  | `false` |  |
| `storage.anonymous` | boolean |  | `false` |  |

**`storage.credentials.method: static`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.credentials.access_key_id` 🔒 | string | Yes |  |  |
| `storage.credentials.secret_access_key` 🔒 | string | Yes |  |  |
| `storage.credentials.session_token` 🔒 | string |  |  |  |

**`storage.credentials.method: profile`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.credentials.profile_name` | string | Yes |  |  |

**`storage.scheme: gcs`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.project_id` | string |  |  |  |
| `storage.auth.method` | `ambient`, `oauth_token` |  | `ambient` |  |
| `storage.access` | `read_only`, `read_write`, `full_control` |  | `full_control` |  |
| `storage.consistency` | `none`, `size`, `md5` |  | `none` |  |
| `storage.cache_timeout` | number |  |  |  |
| `storage.requester_pays` | boolean |  | `false` |  |
| `storage.session_kwargs` | map&lt;string, string&gt; |  |  |  |
| `storage.service_host` | string |  |  |  |
| `storage.default_location` | string |  |  |  |
| `storage.version_aware` | boolean |  | `false` |  |

**`storage.auth.method: oauth_token`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.auth.token` 🔒 | string | Yes |  |  |
| `storage.auth.token_expires_at_ms` | integer |  |  |  |

**`storage.scheme: adls`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.account_name` | string |  |  |  |
| `storage.auth.method` | `ambient`, `connection_string`, `account_key`, `sas_token`, `service_principal`, `access_token`, `credential` |  | `ambient` |  |
| `storage.account_host` | string |  |  |  |
| `storage.blob_storage_authority` | string |  |  |  |
| `storage.dfs_storage_authority` | string |  |  |  |
| `storage.blob_storage_scheme` | `http`, `https` |  | `https` |  |
| `storage.dfs_storage_scheme` | `http`, `https` |  | `https` |  |

**`storage.auth.method: connection_string`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.auth.connection_string` 🔒 | string | Yes |  |  |

**`storage.auth.method: account_key`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.auth.account_key` 🔒 | string | Yes |  |  |

**`storage.auth.method: sas_token`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.auth.sas_token` 🔒 | string | Yes |  |  |

**`storage.auth.method: service_principal`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.auth.tenant_id` | string | Yes |  |  |
| `storage.auth.client_id` | string | Yes |  |  |
| `storage.auth.client_secret` 🔒 | string | Yes |  |  |

**`storage.auth.method: access_token`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.auth.token` 🔒 | string | Yes |  |  |

**`storage.auth.method: credential`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.auth.credential` 🔒 | string | Yes |  |  |

**`storage.scheme: hdfs`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.host` | string | Yes |  |  |
| `storage.port` | integer |  | `8020` |  |
| `storage.user` | string |  |  |  |
| `storage.kerberos_ticket` | string |  |  |  |

**`storage.scheme: hugging_face`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storage.endpoint` | string |  | `https://huggingface.co` |  |
| `storage.token` 🔒 | string |  |  |  |

:::
