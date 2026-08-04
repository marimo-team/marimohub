<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#64748B;vertical-align:-1px"></span> `custom_env` · other · config schema v1

::: details Environment variables configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `vars` | map&lt;string, string&gt; |  |  | Plain environment variables, visible to project managers |
| `secrets` | object[] |  |  | Secret environment variables from encrypted values or an external manager |
| `secrets[].name` | string | Yes |  |  |
| `secrets[].value` 🔒 | string | Yes |  |  |
| `secret_bundles` | object[] |  |  | JSON secret objects expanded into one environment variable per key |
| `secret_bundles[].name` | string | Yes |  | Stable name used to retain this bundle across edits |
| `secret_bundles[].value` 🔒 | string | Yes |  | A JSON object containing environment variable values |
| `secret_bundles[].prefix` | string |  |  |  |

:::
