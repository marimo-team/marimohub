<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#6366F1;vertical-align:-1px"></span> `better_stack_logs` · other · config schema v1 · connection test supported

::: details Better Stack logs configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string | Yes |  | Full OTLP/HTTP JSON logs URL, including /v1/logs |
| `source_token` 🔒 | string | Yes |  |  |
| `level` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |  | `INFO` |  |
| `service_name` | string |  | `marimohub-notebook` |  |

:::
