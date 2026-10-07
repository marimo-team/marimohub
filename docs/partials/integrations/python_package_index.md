<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#3776AB;vertical-align:-1px"></span> `python_package_index` · package_registry · config schema v1 · connection test supported

::: details Python package index configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string | Yes |  | Full Python simple-index URL, including its path |
| `auth.method` | `none`, `basic` |  | `none` |  |
| `default_index` | boolean |  | `false` | Replace public PyPI with this repository |

**`auth.method: basic`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.username` | string | Yes |  |  |
| `auth.password` 🔒 | string | Yes |  | Password or access token |

:::
