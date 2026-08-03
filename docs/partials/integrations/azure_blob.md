<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#0078D4;vertical-align:-1px"></span> `azure_blob` · storage · config schema v1

**Notebook packages:** `adlfs>=2024.7`, `azure-storage-blob>=12.22`, `azure-identity>=1.17`

::: details Azure Blob Storage configuration reference

Fields marked 🔒 are secret: encrypted at rest and write-only after save.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `account_name` | string | Yes |  |  |
| `container` | string |  |  | Default container for notebook code |
| `endpoint_suffix` | string |  | `core.windows.net` | Sovereign clouds use their own, e.g. core.chinacloudapi.cn |
| `auth.method` | `ambient`, `account_key`, `sas_token`, `connection_string`, `service_principal` | Yes |  |  |
| `ambient_env` | boolean |  | `true` | Also export the vendor-standard variables so libraries pick this up with no configuration. Only one integration per session can claim them. |

**`auth.method: account_key`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.account_key` 🔒 | string | Yes |  |  |

**`auth.method: sas_token`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.sas_token` 🔒 | string | Yes |  |  |

**`auth.method: connection_string`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.connection_string` 🔒 | string | Yes |  |  |

**`auth.method: service_principal`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.tenant_id` | string | Yes |  |  |
| `auth.client_id` | string | Yes |  |  |
| `auth.client_secret` 🔒 | string | Yes |  |  |

:::
