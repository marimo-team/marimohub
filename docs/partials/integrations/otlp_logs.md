<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#F5A800;vertical-align:-1px"></span> `otlp_logs` · other · config schema v1 · connection test supported

::: details OpenTelemetry logs configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string | Yes |  | Full OTLP/HTTP JSON logs URL, including /v1/logs |
| `auth.method` | `none`, `bearer`, `basic`, `headers` |  | `none` | How export requests authenticate |
| `level` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |  | `INFO` | Lowest Python log level to export |
| `logger_names` | object[] |  |  | Export only these logger namespaces, up to 32 unique names. Leave empty to export all eligible loggers. |
| `logger_names[].name` | string | Yes |  | Logger name, including its dotted descendants. Up to 256 characters, with no whitespace or empty dot-separated parts. |
| `service_name` | string |  | `marimohub-notebook` | OpenTelemetry `service.name` resource attribute |

**`auth.method: bearer`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.token` 🔒 | string | Yes |  | Token sent as `Authorization: Bearer <token>` |

**`auth.method: basic`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.username` | string | Yes |  | Basic-auth username |
| `auth.password` 🔒 | string | Yes |  | Basic-auth password or token |

**`auth.method: headers`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.headers` | object[] | Yes |  | HTTP headers sent with every export request, such as an API key or tenant ID |
| `auth.headers[].name` | string | Yes |  | HTTP header name |
| `auth.headers[].value` 🔒 | string | Yes |  | Header value, stored as a secret |

:::
