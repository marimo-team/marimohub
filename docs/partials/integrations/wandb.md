<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;padding:3px;border-radius:6px;background:var(--vp-c-default-soft);vertical-align:-7px"><svg role="img" aria-label="Weights & Biases logo" viewBox="0 0 24 24" width="18" height="18" fill="#FFBE00"><path d="M2.48 0a1.55 1.55 0 1 0 0 3.1 1.55 1.55 0 0 0 0-3.1zm19.04 0a1.55 1.55 0 1 0 0 3.101 1.55 1.55 0 0 0 0-3.101zM12 2.295a1.55 1.55 0 1 0 0 3.1 1.55 1.55 0 0 0 0-3.1zM2.48 5.272a2.48 2.48 0 1 0 0 4.96 2.48 2.48 0 0 0 0-4.96zm19.04 0a2.48 2.48 0 1 0 0 4.96 2.48 2.48 0 0 0 0-4.96zM12 8.496a1.55 1.55 0 1 0 0 3.1 1.55 1.55 0 0 0 0-3.1zm-9.52 3.907a1.55 1.55 0 1 0 0 3.1 1.55 1.55 0 0 0 0-3.1zm19.04 0a1.55 1.55 0 1 0 0 3.102 1.55 1.55 0 0 0 0-3.102zM12 13.767a2.48 2.48 0 1 0 0 4.962 2.48 2.48 0 0 0 0-4.962zm-9.52 3.907a2.48 2.48 0 1 0 .001 4.962 2.48 2.48 0 0 0 0-4.962zm19.04.93a1.55 1.55 0 1 0 0 3.102 1.55 1.55 0 0 0 0-3.101zM12 20.9a1.55 1.55 0 1 0 0 3.1 1.55 1.55 0 0 0 0-3.1Z"/></svg></span> `wandb` · other · config schema v1 · connection test supported

**Notebook packages:** `wandb>=0.18`

::: details Weights & Biases configuration reference

Fields marked 🔒 use an encrypted value or an external reference. API responses never contain the resolved value.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `api_key` 🔒 | string | Yes |  | API key from wandb.ai/authorize |
| `base_url` | string |  | `https://api.wandb.ai` | Set this for a self-hosted or dedicated-cloud deployment |
| `entity` | string |  |  | Default team or user |
| `project` | string |  |  |  |
| `mode` | `online`, `offline` |  | `online` | `offline` records runs to disk without contacting the server |

:::
