<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#8C4FFF;vertical-align:-1px"></span> `athena` · engine · config schema v1

**Notebook packages:** `pyathena[sqlalchemy]>=3.9`

::: details Amazon Athena configuration reference

Fields marked 🔒 are secret: encrypted at rest and write-only after save.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `region` | string | Yes |  |  |
| `s3_staging_dir` | string | Yes |  | Bucket prefix Athena writes query results to |
| `database` | string |  | `default` |  |
| `workgroup` | string |  | `primary` |  |
| `catalog` | string |  | `AwsDataCatalog` |  |
| `auth.method` | `ambient`, `static` |  | `ambient` |  |

**`auth.method: static`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.access_key_id` 🔒 | string | Yes |  |  |
| `auth.secret_access_key` 🔒 | string | Yes |  |  |
| `auth.session_token` 🔒 | string |  |  |  |

:::
