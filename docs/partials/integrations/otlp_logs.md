<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#F5A800;vertical-align:-1px"></span> `otlp_logs` · other · config schema v1

::: details OpenTelemetry logs configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string | Yes |  | Full OTLP/HTTP logs URL, including /v1/logs |
| `headers` | object[] |  |  |  |
| `headers[].name` | string | Yes |  |  |
| `headers[].value` 🔒 | string | Yes |  |  |
| `level` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |  | `INFO` |  |
| `service_name` | string |  | `marimohub-notebook` |  |

:::
