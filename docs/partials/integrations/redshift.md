<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#8C4FFF;vertical-align:-1px"></span> `redshift` · database · config schema v1

**Notebook packages:** `sqlalchemy-redshift>=0.14`, `redshift-connector>=2.1`

::: details Amazon Redshift configuration reference

Fields marked 🔒 are secret: encrypted at rest and write-only after save.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `host` | string | Yes |  | Cluster or workgroup endpoint, e.g. wg.123456789012.us-east-1.redshift-serverless.amazonaws.com |
| `port` | integer |  | `5439` |  |
| `database` | string | Yes |  |  |
| `username` | string | Yes |  |  |
| `password` 🔒 | string | Yes |  | Password for the database user |
| `ssl_mode` | `verify-ca`, `verify-full` |  | `verify-ca` |  |

:::
