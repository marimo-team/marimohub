<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;padding:3px;border-radius:6px;background:var(--vp-c-default-soft);vertical-align:-7px"><svg role="img" aria-label="DuckDB logo" viewBox="0 0 24 24" width="18" height="18" fill="#FFF000"><path d="M12 0C5.363 0 0 5.363 0 12s5.363 12 12 12 12-5.363 12-12S18.637 0 12 0zM9.502 7.03a4.974 4.974 0 0 1 4.97 4.97 4.974 4.974 0 0 1-4.97 4.97A4.974 4.974 0 0 1 4.532 12a4.974 4.974 0 0 1 4.97-4.97zm6.563 3.183h2.351c.98 0 1.787.782 1.787 1.762s-.807 1.789-1.787 1.789h-2.351v-3.551z"/></svg></span> `motherduck` · database · config schema v1

**Notebook packages:** `duckdb>=1.1`

::: details MotherDuck configuration reference

Fields marked 🔒 are secret: encrypted at rest and write-only after save.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `token` 🔒 | string | Yes |  | MotherDuck service token |
| `database` | string |  |  | Database to attach; omit to attach every database in the account |
| `saas_mode` | boolean |  | `false` | Block local file and extension access from the MotherDuck session |

:::
