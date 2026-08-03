<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#232F3E;vertical-align:-1px"></span> `iceberg_glue` · catalog · config schema v1

**Notebook packages:** `pyiceberg[pyarrow,glue,s3fs,gcsfs,adlfs,hf]>=0.11`

::: details Iceberg AWS Glue Catalog configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `warehouse` | string |  |  | Default Iceberg table storage location |
| `catalog_id` | string |  |  |  |
| `region` | string |  |  |  |
| `endpoint` | string |  |  |  |
| `credentials.method` | `ambient`, `static`, `profile` |  | `ambient` | Glue Catalog credentials only. When explicit, these override unified credentials for Glue calls. |
| `unified_credentials.method` | `none`, `static`, `profile`, `role` |  | `none` | Client credentials shared by Glue and S3 FileIO. Glue-specific and storage-specific credentials override these. |
| `skip_archive` | boolean |  | `true` |  |
| `max_retries` | integer |  | `10` |  |
| `retry_mode` | `legacy`, `standard`, `adaptive` |  | `standard` |  |
| `storage` |  |  |  |  |
| `runtime` |  |  |  |  |
| `extra_properties` |  |  |  |  |

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

:::
