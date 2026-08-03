<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;padding:3px;border-radius:6px;background:var(--vp-c-default-soft);vertical-align:-7px"><svg role="img" aria-label="Google BigQuery logo" viewBox="0 0 24 24" width="18" height="18" fill="#669DF6"><path d="M5.676 10.595h2.052v5.244a5.892 5.892 0 0 1-2.052-2.088v-3.156zm18.179 10.836a.504.504 0 0 1 0 .708l-1.716 1.716a.504.504 0 0 1-.708 0l-4.248-4.248a.206.206 0 0 1-.007-.007c-.02-.02-.028-.045-.043-.066a10.736 10.736 0 0 1-6.334 2.065C4.835 21.599 0 16.764 0 10.799S4.835 0 10.8 0s10.799 4.835 10.799 10.8c0 2.369-.772 4.553-2.066 6.333.025.017.052.028.074.05l4.248 4.248zm-5.028-10.632a8.015 8.015 0 1 0-8.028 8.028h.024a8.016 8.016 0 0 0 8.004-8.028zm-4.86 4.98a6.002 6.002 0 0 0 2.04-2.184v-1.764h-2.04v3.948zm-4.5.948c.442.057.887.08 1.332.072.4.025.8.025 1.2 0V7.692H9.468v9.035z"/></svg></span> `iceberg_bigquery` · catalog · config schema v1

**Notebook packages:** `pyiceberg[pyarrow,bigquery,gcsfs,s3fs,adlfs,hf]>=0.11`

::: details Iceberg BigQuery Metastore Catalog configuration reference

Fields marked 🔒 are secret: encrypted at rest and write-only after save.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `project_id` | string | Yes |  |  |
| `location` | string |  |  |  |
| `warehouse` | string | Yes |  |  |
| `credentials.method` | `ambient`, `service_account_json` |  | `ambient` |  |
| `storage.scheme` | `catalog`, `s3`, `gcs`, `adls`, `hdfs`, `hugging_face` |  | `catalog` |  |
| `runtime.max_workers` | integer |  |  |  |
| `runtime.legacy_current_snapshot_id` | boolean |  |  |  |
| `runtime.downcast_ns_timestamp_to_us_on_write` | boolean |  |  |  |
| `runtime.pyarrow_use_large_types_on_read` | boolean |  |  |  |
| `extra_properties` | map&lt;string, string&gt; |  |  | Raw PyIceberg catalog properties not represented by typed fields |

**`credentials.method: service_account_json`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `credentials.credentials_json` 🔒 | string | Yes |  |  |

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
