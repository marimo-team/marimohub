<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#F46800;vertical-align:-1px"></span> `grafana_cloud_logs` · other · config schema v1

::: details Grafana Cloud logs configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string | Yes |  | Full OTLP/HTTP logs URL, including /v1/logs |
| `username` | string | Yes |  | Grafana Cloud OTLP instance ID |
| `token` 🔒 | string | Yes |  | Access policy token with permission to write logs |
| `level` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |  | `INFO` |  |
| `service_name` | string |  | `marimohub-notebook` |  |

:::
