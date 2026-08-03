<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#232F3E;vertical-align:-1px"></span> `iceberg_glue` · catalog · config schema v1

**Notebook packages:** `pyiceberg[pyarrow,glue,s3fs,gcsfs,adlfs,hf]>=0.11`

::: details Iceberg AWS Glue Catalog configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `warehouse` | string |  |  |  |
| `catalog_id` | string |  |  |  |
| `region` | string |  |  |  |
| `endpoint` | string |  |  |  |
| `credentials.method` | `ambient`, `static`, `profile` |  | `ambient` |  |
| `unified_credentials.method` | `none`, `static`, `profile`, `role` |  | `none` |  |
| `skip_archive` | boolean |  | `true` |  |
| `max_retries` | integer |  | `10` |  |
| `retry_mode` | `legacy`, `standard`, `adaptive` |  | `standard` |  |
| `storage.scheme` | `catalog`, `s3`, `gcs`, `adls`, `hdfs`, `hugging_face` |  | `catalog` |  |
| `runtime.max_workers` | integer |  |  |  |
| `runtime.legacy_current_snapshot_id` | boolean |  |  |  |
| `runtime.downcast_ns_timestamp_to_us_on_write` | boolean |  |  |  |
| `runtime.pyarrow_use_large_types_on_read` | boolean |  |  |  |
| `extra_properties` | map&lt;string, string&gt; |  |  | Raw PyIceberg catalog properties not represented by typed fields |

**`credentials.method: static`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `credentials.access_key_id` 🔒 | string | Yes |  |  |
| `credentials.secret_access_key` 🔒 | string | Yes |  |  |
| `credentials.session_token` 🔒 | string |  |  |  |

**`credentials.method: profile`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `credentials.profile_name` | string | Yes |  |  |

**`unified_credentials.method: static`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `unified_credentials.region` | string |  |  |  |
| `unified_credentials.access_key_id` 🔒 | string | Yes |  |  |
| `unified_credentials.secret_access_key` 🔒 | string | Yes |  |  |
| `unified_credentials.session_token` 🔒 | string |  |  |  |

**`unified_credentials.method: profile`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `unified_credentials.region` | string |  |  |  |
| `unified_credentials.profile_name` | string | Yes |  |  |

**`unified_credentials.method: role`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `unified_credentials.region` | string |  |  |  |
| `unified_credentials.role_arn` | string | Yes |  |  |
| `unified_credentials.role_session_name` | string |  |  |  |

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
