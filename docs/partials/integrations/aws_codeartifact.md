<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#FF9900;vertical-align:-1px"></span> `aws_codeartifact` · package_registry · config schema v1 · connection test supported

::: details AWS CodeArtifact configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `domain` | string | Yes |  |  |
| `domain_owner` | string | Yes |  | AWS account ID that owns the domain |
| `repository` | string | Yes |  |  |
| `region` | string |  | `us-east-1` |  |
| `default_index` | boolean |  | `false` | Replace public PyPI with this repository |
| `duration_seconds` | integer |  | `43200` | Token lifetime in seconds. Restart the session after expiry. |
| `auth.method` | `federation`, `static`, `token` | Yes |  |  |

**`auth.method: static`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.access_key_id` 🔒 | string | Yes |  |  |
| `auth.secret_access_key` 🔒 | string | Yes |  |  |
| `auth.session_token` 🔒 | string |  |  |  |

**`auth.method: token`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.token` 🔒 | string | Yes |  |  |

:::
