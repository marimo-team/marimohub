<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;padding:3px;border-radius:6px;background:var(--vp-c-default-soft);vertical-align:-7px"><svg role="img" aria-label="Google BigQuery logo" viewBox="0 0 24 24" width="18" height="18" fill="#669DF6"><path d="M5.676 10.595h2.052v5.244a5.892 5.892 0 0 1-2.052-2.088v-3.156zm18.179 10.836a.504.504 0 0 1 0 .708l-1.716 1.716a.504.504 0 0 1-.708 0l-4.248-4.248a.206.206 0 0 1-.007-.007c-.02-.02-.028-.045-.043-.066a10.736 10.736 0 0 1-6.334 2.065C4.835 21.599 0 16.764 0 10.799S4.835 0 10.8 0s10.799 4.835 10.799 10.8c0 2.369-.772 4.553-2.066 6.333.025.017.052.028.074.05l4.248 4.248zm-5.028-10.632a8.015 8.015 0 1 0-8.028 8.028h.024a8.016 8.016 0 0 0 8.004-8.028zm-4.86 4.98a6.002 6.002 0 0 0 2.04-2.184v-1.764h-2.04v3.948zm-4.5.948c.442.057.887.08 1.332.072.4.025.8.025 1.2 0V7.692H9.468v9.035z"/></svg></span> `bigquery` · database · config schema v1

**Notebook packages:** `google-cloud-bigquery>=3.25`, `sqlalchemy-bigquery>=1.11`

::: details BigQuery configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `project_id` | string | Yes |  | Google Cloud project that owns the datasets |
| `dataset` | string |  |  | Default dataset for unqualified table names |
| `location` | string |  |  | Dataset location, e.g. US or europe-west4 |
| `auth.method` | `ambient`, `service_account` |  | `ambient` |  |
| `ambient_env` | boolean |  | `false` | Also export the vendor-standard variables so libraries pick this up with no configuration. Only one integration per session can claim them. |

**`auth.method: service_account`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.credentials_json` 🔒 | string | Yes |  |  |

:::
