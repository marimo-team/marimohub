<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#FF9900;vertical-align:-1px"></span> `aws_codeartifact` · package_registry · config schema v1 · connection test supported

::: details AWS CodeArtifact configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `domain` | string | Yes |  | CodeArtifact domain name |
| `domain_owner` | string | Yes |  | AWS account ID that owns the domain |
| `repository` | string | Yes |  | CodeArtifact repository name |
| `region` | string |  | `us-east-1` | AWS region of the domain, for example us-east-1 |
| `auth.method` | `ambient`, `static` | Yes |  | How the hub gets AWS credentials to mint the CodeArtifact token: `ambient` uses the project's workload identity (WIF), `static` uses the AWS keys below. Neither reaches the sandbox. |
| `default_index` | boolean |  | `false` | Replace public PyPI with this repository |

**`auth.method: static`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.access_key_id` 🔒 | string | Yes |  |  |
| `auth.secret_access_key` 🔒 | string | Yes |  |  |
| `auth.session_token` 🔒 | string |  |  |  |

:::
