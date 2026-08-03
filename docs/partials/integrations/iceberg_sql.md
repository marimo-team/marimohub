<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#0969DA;vertical-align:-1px"></span> `iceberg_sql` · catalog · config schema v1

**Notebook packages:** `pyiceberg[pyarrow,sql-postgres,sql-sqlite,s3fs,gcsfs,adlfs,hf]>=0.11`

::: details Iceberg SQL Catalog configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `uri` 🔒 | string | Yes |  | SQLAlchemy URI for PostgreSQL or SQLite |
| `warehouse` | string |  |  | Default Iceberg table storage location |
| `init_catalog_tables` | boolean |  | `true` |  |
| `echo` | boolean |  | `false` |  |
| `pool_pre_ping` | boolean |  | `false` |  |
| `storage` |  |  |  |  |
| `runtime` |  |  |  |  |
| `extra_properties` |  |  |  |  |

:::
