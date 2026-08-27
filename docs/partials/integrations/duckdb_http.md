<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#FFF000;vertical-align:-1px"></span> `duckdb_http` · database · config schema v1

::: details Remote DuckDB Database configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string | Yes |  | Exact HTTPS URL of one immutable DuckDB database file |
| `auth.method` | `none`, `bearer_token`, `basic` | Yes |  |  |
| `allow_non_duckdb_suffix` | boolean |  | `false` | Allow a URL path that does not end in .duckdb |

**`auth.method: bearer_token`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.token` 🔒 | string | Yes |  |  |

**`auth.method: basic`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.username` | string | Yes |  |  |
| `auth.password` 🔒 | string | Yes |  |  |

:::
