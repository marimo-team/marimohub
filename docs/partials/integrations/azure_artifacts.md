<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#0078D4;vertical-align:-1px"></span> `azure_artifacts` · package_registry · config schema v1 · connection test supported

::: details Azure Artifacts configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `organization` | string | Yes |  |  |
| `project` | string |  |  | Omit for an organization-scoped feed |
| `feed` | string | Yes |  |  |
| `auth.method` | `token` | Yes |  |  |
| `auth.token` 🔒 | string | Yes |  | Azure DevOps personal access token with Packaging read permission |
| `default_index` | boolean |  | `false` | Replace public PyPI with this repository |

:::
