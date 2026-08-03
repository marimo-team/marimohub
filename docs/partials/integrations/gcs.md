<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;padding:3px;border-radius:6px;background:var(--vp-c-default-soft);vertical-align:-7px"><svg role="img" aria-label="Google Cloud Storage logo" viewBox="0 0 24 24" width="18" height="18" fill="#AECBFA"><path d="M24 2.4v8.4h-2.4V2.4H24zM0 10.8h2.4V2.4H0v8.4zm3-8.4h18v8.4H3V2.4zm12.6 4.2a1.8 1.8 0 1 0 3.6 0 1.8 1.8 0 0 0-3.6 0zm-10.8.6H12V6H4.8v1.2zm16.8 14.4H24v-8.4h-2.4v8.4zM0 21.6h2.4v-8.4H0v8.4zm3-8.4h18v8.4H3v-8.4zm12.6 4.2a1.8 1.8 0 1 0 3.6 0 1.8 1.8 0 0 0-3.6 0zM4.8 18H12v-1.2H4.8V18z"/></svg></span> `gcs` · storage · config schema v1

**Notebook packages:** `gcsfs>=2024.6`, `google-cloud-storage>=2.18`

::: details Google Cloud Storage configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `bucket` | string |  |  | Default bucket for notebook code; the credentials are not restricted to it |
| `project_id` | string |  |  | Project billed for the requests |
| `auth.method` | `ambient`, `service_account` |  | `ambient` |  |
| `ambient_env` | boolean |  | `true` | Also export the vendor-standard variables so libraries pick this up with no configuration. Only one integration per session can claim them. |

**`auth.method: service_account`**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `auth.credentials_json` 🔒 | string | Yes |  |  |

:::
