<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;padding:3px;border-radius:6px;background:var(--vp-c-default-soft);vertical-align:-7px"><svg role="img" aria-label="Databricks logo" viewBox="0 0 24 24" width="18" height="18" fill="#FF3621"><path d="M.95 14.184L12 20.403l9.919-5.55v2.21L12 22.662l-10.484-5.96-.565.308v.77L12 24l11.05-6.218v-4.317l-.515-.309L12 19.118l-9.867-5.653v-2.21L12 16.805l11.05-6.218V6.32l-.515-.308L12 11.974 2.647 6.681 12 1.388l7.76 4.368.668-.411v-.566L12 0 .95 6.27v.72L12 13.207l9.919-5.55v2.26L12 15.52 1.516 9.56l-.565.308Z"/></svg></span> `databricks` · engine · config schema v1 · connection test supported

**Notebook packages:** `databricks-sql-connector>=3.4`, `databricks-sqlalchemy>=1.0`

::: details Databricks SQL configuration reference

Fields marked 🔒 are secret: encrypted at rest and write-only after save.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `host` | string | Yes |  | Workspace hostname, e.g. dbc-1234abcd-5678.cloud.databricks.com |
| `http_path` | string | Yes |  | SQL warehouse or cluster HTTP path |
| `auth.method` | `personal_access_token`, `oauth_m2m` | Yes |  |  |
| `catalog` | string |  |  | Unity Catalog name for unqualified tables |
| `schema` | string |  |  | Session default schema |

**`auth.method: personal_access_token`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.token` 🔒 | string | Yes |  |  |

**`auth.method: oauth_m2m`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.client_id` | string | Yes |  |  |
| `auth.client_secret` 🔒 | string | Yes |  |  |

:::
