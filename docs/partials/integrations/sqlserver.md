<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#CC2927;vertical-align:-1px"></span> `sqlserver` · database · config schema v1

**Notebook packages:** `sqlalchemy>=2`, `pyodbc>=5.1`, `pymssql>=2.3`

::: details Microsoft SQL Server configuration reference

Fields marked 🔒 are secret: encrypted at rest and write-only after save.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `host` | string | Yes |  | Server hostname, e.g. mssql.internal |
| `port` | integer |  | `1433` |  |
| `database` | string | Yes |  |  |
| `username` | string | Yes |  |  |
| `password` 🔒 | string | Yes |  | Password for the database user |
| `driver.name` | `pyodbc`, `pymssql` |  | `pyodbc` |  |

**`driver.name: pyodbc`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `driver.odbc_driver` | string |  | `ODBC Driver 18 for SQL Server` | Must be installed in the sandbox image |
| `driver.encrypt` | boolean |  | `true` |  |
| `driver.trust_server_certificate` | boolean |  | `false` | Accept any server certificate — encrypts without authenticating |

:::
