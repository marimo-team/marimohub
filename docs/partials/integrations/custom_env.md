<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#64748B;vertical-align:-1px"></span> `custom_env` · other · config schema v1

::: details Custom environment configuration reference

Fields marked 🔒 are secret: encrypted at rest and write-only after save.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `vars` | map&lt;string, string&gt; |  |  | Plain environment variables, visible to project admins |
| `secrets` | object[] |  |  | Secret environment variables, write-only after save |
| `secrets[].name` | string | Yes |  |  |
| `secrets[].value` 🔒 | string | Yes |  |  |

:::
