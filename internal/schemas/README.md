# Committed schema specs

OpenAPI 3.1 renderings of marimohub's persisted-data and API contracts,
committed so every contract change shows up in review as a plain-text diff and
CI can flag the breaking ones.

| Spec                                                                 | Contract                                  | Generated from                                             |
| -------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| [`bucket.yml`](./bucket.yml)                                         | Every JSON object persisted in the bucket | zod schemas in `packages/core/src/schema.ts` + `paths.ts`  |
| [`integrations.yml`](./integrations.yml)                             | Every integration kind's config schema    | `defaultRegistry()` (`core/…/services/integrations/kinds`) |
| [`../../packages/api/openapi.yaml`](../../packages/api/openapi.yaml) | The HTTP API                              | `@hono/zod-openapi` routes in `packages/api`               |

The API spec stays in `packages/api` (it is published at `/openapi.yaml` and
feeds `@marimo-hub/client` codegen) but is covered by the same CI gate.

## Regenerating

```sh
pnpm schemas:generate
```

Never edit the yml files by hand. Drift tests
(`packages/core/src/specs/internal-schemas.spec.test.ts` and
`packages/api/src/openapi.spec.test.ts`) fail the build when a committed spec
no longer matches the code, so a schema change cannot land without its spec
diff.

## How bucket.yml and integrations.yml are modeled

These are not HTTP APIs — OpenAPI is used as a diffable schema container:

- Each bucket object (or integration kind) is a path whose template is derived
  from `paths.ts`. **GET** models what readers must accept; **PUT** models
  what writers produce. Both reference one component schema, so oasdiff's
  breaking-change rules map onto stored-data compatibility in both directions:
  removing or narrowing a field breaks readers (GET), and a new required
  field invalidates already-stored objects (PUT).
- Schemas use zod's input io, matching what `parseStored` accepts (defaulted
  fields stay optional).
- `x-mutability`/`x-owner` mirror the write-ownership invariants in AGENTS.md.
  `x-secret-paths` tracks where secret envelopes live; moving one requires a
  decrypt-and-reseal migration.
- Each integration kind is its own path: retiring a kind is breaking, adding
  one is additive.
- `x-brand-icon`/`x-brand-color` carry each kind's vendor presentation
  (simple-icons slug + hex). `integrations.yml` also drives the per-kind
  config-reference partials in `docs/partials/integrations/`, regenerated and
  drift-guarded by `apps/docs/.vitepress/integrations-docs/generate.test.ts`
  as part of `pnpm schemas:generate`.

## Breaking-change CI

`.github/workflows/schemas.yml` runs on PRs touching any spec. For each spec
that differs from the base branch it posts an oasdiff changelog to the job
summary and fails on error-level breaking changes
(`oasdiff breaking --fail-on ERR`).

`response-property-enum-value-added` remains warning-level. Response enums may
grow when their runtime schema normalizes unrecognized strings to an explicit
`unknown` member, so generated clients retain an exhaustive fallback.

To land a vetted breaking change, add a line to the matching file in
[`allowed-breaking/`](./allowed-breaking). A line suppresses a finding when it
contains both the endpoint (e.g. `GET /example/{id}`) and the finding's
description text, backticks included. Remove the line once the PR merges —
the finding disappears from the new baseline, and a stale entry would mask a
future accidental break.
