# Plan 009: Single-source the data schemas — stop duplicating them across core, api, and web

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update this plan's status
> row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- packages/core/src/schema.ts packages/api/src/shared.ts packages/web/src/types/index.ts packages/client/src`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (touches the OpenAPI response schemas; a mistake changes the published API contract — verify the generated doc is unchanged)
- **Depends on**: 001 (verification baseline); do after the P1/P2 plans
- **Category**: tech-debt
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

The same data shapes are defined **three times**:

- `packages/core/src/schema.ts` — the zod domain schemas (source of truth for
  storage validation).
- `packages/api/src/shared.ts` — near-identical zod schemas with `.openapi(...)`
  metadata, used to generate the OpenAPI doc and validate responses.
- `packages/web/src/types/index.ts` — hand-written TypeScript interfaces
  mirroring the API responses, even though `packages/client` is generated from
  the OpenAPI doc.

Three copies drift: a field added in core can be missed in the API schema (so
the contract lies) or in the web types (so the UI compiles against a stale
shape). This plan collapses the duplication to one source per concern: domain
schemas live in `core`; the API layer derives its OpenAPI schemas from them; the
web consumes the generated `@marimo-hub/client` types instead of hand-written
ones.

## Current state

- **`packages/core/src/schema.ts`** — canonical zod schemas:
  `SnapshotNotebookEntrySchema`, `SnapshotProjectEntrySchema`, `ProjectSchema`,
  `NotebookMetaSchema`, `SourceSchema` (discriminated union local|github),
  `VersionSchema`, `SessionSchema`, plus `toPublicNotebookEntry` /
  `toPublicProjectEntry` that strip the internal `key_prefix`.
- **`packages/api/src/shared.ts`** (lines ~119–251) — re-declares the same
  shapes as `ProjectResponseSchema`, `SnapshotNotebookEntrySchema` (note: the
  API copy omits `key_prefix`, matching the public shape),
  `NotebookMetaResponseSchema`, `SourceResponseSchema`, `VersionResponseSchema`,
  `SessionResponseSchema`, each ending in `.openapi('Name')`. These names feed
  the OpenAPI components and the route response validators.
- **`packages/web/src/types/index.ts`** — hand-written interfaces
  `ProjectSummary`, `NotebookEntry`, `NotebookMeta`, `Session`, `ApiResponse<T>`,
  etc., mirroring the API responses.
- **`packages/client`** — `src/index.ts` + `src/schema.ts` (generated from the
  OpenAPI doc; `generateOpenApiDocument()` in `packages/api/src/createApi.ts`
  produces the doc). The web already imports from `@marimo-hub/client` for the
  fetch client (`packages/web/src/api/client.ts`).

The API response schemas intentionally differ from core in two ways: (a) they
omit `key_prefix` (public shape), and (b) they carry `.openapi(...)` metadata and
looser datetime typing (`dt()` helper). So the consolidation must preserve the
public/internal distinction.

## Commands you will need

| Purpose                                   | Command      | Expected              |
| ----------------------------------------- | ------------ | --------------------- |
| Test all                                  | `pnpm test`  | all pass              |
| Check                                     | `pnpm check` | exit 0                |
| Build                                     | `pnpm build` | exit 0                |
| Regen client (if a codegen script exists) | see Step 4   | OpenAPI doc unchanged |

## Scope

**In scope** (do this in two independent, separately-verifiable parts):

- **Part A (web → client types)**: `packages/web/src/types/index.ts` and the web
  modules importing it.
- **Part B (api ← core schemas)**: `packages/api/src/shared.ts` and
  `packages/core/src/schema.ts` (add `.openapi`-friendly exports / a derivation).

**Out of scope** (do NOT touch):

- The storage validation in core services (they keep parsing with the core
  schemas).
- Any change to the actual JSON shapes / the public API contract — the generated
  OpenAPI doc must be byte-identical before and after (see Step 4).
- `packages/client`'s generated files — regenerate via the codegen, do not
  hand-edit.

## Git workflow

- Branch: `advisor/009-single-source-schemas`
- Two commits (one per part) so each is independently revertable.
- Commit messages: `web: consume generated client types` / `api: derive OpenAPI schemas from core`.

## Steps

### Step 1 (Part A): Point the web at the generated client types

Identify what `@marimo-hub/client` exports (read `packages/client/src/index.ts`
and `schema.ts`). The generated schema exposes the response component types.
Replace the hand-written interfaces in `packages/web/src/types/index.ts` with
re-exports/aliases of the generated types where an equivalent exists (e.g.
`ProjectSummary` → the client's `SnapshotProjectEntry`, `Session` → the client's
`Session`). Keep only genuinely web-local types (e.g. `User` with `logoutUrl`,
if the client lacks it) and clearly mark them as web-local.

Update the imports in web components/hooks that referenced the old interfaces
(`grep -rn "from '../types'\|from './types'\|types/index" packages/web/src`).

**Verify**: `pnpm --filter @marimo-hub/web build` (or `pnpm build`) → exit 0, no
type errors. The UI still typechecks against the generated contract.

### Step 2 (Part A): Confirm no behavioral change

The web is types-only here. Confirm the build output is functionally identical
(no runtime imports changed beyond types).

**Verify**: `pnpm check` exits 0; `pnpm build` exits 0.

### Step 3 (Part B): Derive API OpenAPI schemas from core

Choose the lowest-risk approach:

- **Preferred**: in `packages/core/src/schema.ts`, export the base zod schemas
  (already done) and, in `packages/api`, build the `*ResponseSchema` objects by
  taking the core schema's shape and applying `.openapi(...)` + the public
  transform (omit `key_prefix`). Zod allows `CoreSchema.omit({ key_prefix: true }).openapi('Name')`.
  Centralize these in a new `packages/api/src/openapi-schemas.ts` and re-export
  from `shared.ts` so route files keep importing the same names.
- If wiring core zod into the `@hono/zod-openapi` `z` instance causes
  instance-identity issues (two `zod` copies), fall back to: keep the API
  schemas declared in `api`, but add a **type-level conformance test** that
  asserts the API response types are assignable to/from the core public types
  (a `expectTypeOf`/`satisfies`-based test), so drift becomes a compile error
  even if the runtime schemas stay separate. Document which approach you took.

**Verify**: `pnpm --filter @marimo-hub/api test && pnpm check` → pass.

### Step 4: Prove the OpenAPI contract did not change

The published contract must be identical. Generate the doc before and after and
diff it.

- Find the codegen path: `grep -rn "generateOpenApiDocument\|getOpenAPI31Document\|openapi.json" packages` — `packages/client` is generated from
  `generateOpenApiDocument()` in `packages/api/src/createApi.ts`.
- Generate the doc on the pre-change commit and on your branch (e.g. a tiny
  script that imports `generateOpenApiDocument()` and writes JSON), and `diff`
  them.

**Verify**: the two OpenAPI JSON documents are identical (empty `diff`). If they
differ, your schema derivation changed the contract — STOP.

## Test plan

- Part A: the web build is the test (type errors fail it). Add no runtime tests.
- Part B: existing `api` route tests must still pass; add the type-conformance
  test if you took the fallback approach.
- The decisive check is Step 4: the OpenAPI doc is byte-identical.
- Verification: `pnpm test && pnpm build`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `packages/web/src/types/index.ts` no longer hand-declares
      Project/Notebook/Session response shapes already provided by the client
      (it re-exports them or imports them directly).
- [ ] API response schemas are derived from / conformance-checked against the
      core schemas (no third hand-maintained copy).
- [ ] The generated OpenAPI document is identical before vs after (`diff` empty).
- [ ] `pnpm check && pnpm test && pnpm build` exit 0.
- [ ] No files outside the in-scope list modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The OpenAPI doc changes (Step 4 diff non-empty) — the contract moved; revert
  Part B and report what shifted.
- Two `zod` instances cause `.openapi()` to fail at runtime when reusing core
  schemas — take the type-conformance fallback and report.
- The generated client lacks a type the web genuinely needs — keep that one
  interface web-local with a comment, and report the gap (it may indicate a
  missing API field).

## Maintenance notes

- After this lands, adding a field is a one-place change in `core/schema.ts`; a
  reviewer should reject PRs that re-introduce a parallel API or web type.
- This unblocks DIRECTION-05 (publishing `@marimo-hub/client`): once web consumes
  the generated client, the client is the real, exercised contract.
