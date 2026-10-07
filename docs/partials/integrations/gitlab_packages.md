<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#FC6D26;vertical-align:-1px"></span> `gitlab_packages` · package_registry · config schema v1 · connection test supported

::: details GitLab Package Registry configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string |  | `https://gitlab.com` | GitLab instance base URL |
| `scope` | `project`, `group` |  | `project` |  |
| `scope_id` | string | Yes |  | Numeric GitLab project or group ID |
| `auth.method` | `token` | Yes |  |  |
| `auth.username` | string | Yes |  | Deploy token username or personal access token name |
| `auth.token` 🔒 | string | Yes |  | Deploy token with read_package_registry, or personal access token with api scope |
| `default_index` | boolean |  | `false` | Replace public PyPI with this repository |

:::
