<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#41BF47;vertical-align:-1px"></span> `jfrog_artifactory` · package_registry · config schema v1 · connection test supported

::: details JFrog Artifactory configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string | Yes |  | Artifactory base URL, for example https://company.jfrog.io/artifactory |
| `repository` | string | Yes |  | PyPI repository key |
| `auth.method` | `token`, `basic` | Yes |  |  |
| `default_index` | boolean |  | `false` | Replace public PyPI with this repository |

**`auth.method: token`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.token` 🔒 | string | Yes |  |  |

**`auth.method: basic`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.username` | string | Yes |  |  |
| `auth.password` 🔒 | string | Yes |  | Password or access token |

:::
