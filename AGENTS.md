# AGENTS.md

Guidance for coding agents working in this repository (a pnpm + vite-plus
TypeScript monorepo for marimohub). Read this before making changes.

## Build / test / lint commands

| Purpose                | Command                          | Expected on success |
| ---------------------- | -------------------------------- | ------------------- |
| Install                | `pnpm install --frozen-lockfile` | exit 0              |
| Check (typecheck+lint) | `pnpm check`                     | exit 0, no errors   |
| Typecheck (+lint)      | `pnpm typecheck`                 | exit 0, no errors   |
| Tests                  | `pnpm test`                      | all pass            |
| Coverage               | `pnpm test:coverage`             | report (v8)         |
| Build                  | `pnpm build`                     | exit 0              |

The toolchain is **vite-plus** (`vp`). `pnpm check` runs `vp check`
(typecheck + lint); `pnpm typecheck` is an alias for the same (vite-plus does
not expose a type-only command). `pnpm test` runs each package's `test` script
(vitest); `pnpm build` builds every package. Use these as the done-criteria for
any change.

## Architecture (5 bullets)

- **Ports and adapters.** Every external dependency — storage, compute, identity
  — sits behind a TypeScript interface (a _port_). The domain depends on the
  interface, never on a vendor SDK.
- **`packages/core`** holds the domain model, services, and the port interfaces.
  It imports **no vendor SDK** — nothing that speaks to a specific provider or
  performs I/O. Its deps are generic, side-effect-free utilities only: `ulidx`,
  `zod`, `better-all`, `@opentelemetry/api` (a no-op tracing facade unless an
  entrypoint registers a provider), and the format serializers `smol-toml` and
  `yaml` (core renders `marimo.toml` and integration config files). A serializer
  is a pure function, not a vendor, so a port around it would buy no
  substitutability.
  Anything that _reaches_ something — a store, a cluster, an IdP — is a port.
- **Adapters** (`packages/storage-*`, `packages/compute-*`, `packages/auth-*`)
  implement the ports. `packages/api` wires the services to Hono/OpenAPI routes
  via `@hono/zod-openapi`.
- **`packages/config`** is the ONLY package that imports concrete adapters: it
  reads `MARIMOHUB_*` env vars, selects an adapter per `*_BACKEND` selector, and
  wires the system together.
- **Entrypoints** compose everything: `apps/server` (Node, for Docker/k8s) and
  `examples/cloudflare-worker` (Cloudflare Workers). See
  [`development_docs/architecture.md`](./development_docs/architecture.md).

## The dependency rule

Dependencies point **inward only**. `core` and `api` never import an adapter;
adapters depend on `core`'s port interfaces. `config` (and the entrypoints) are
the only places concrete adapters are imported. **Reject PRs that violate this**
— e.g. an `@marimo-hub/storage-*` / `compute-*` / `auth-*` import appearing in
`packages/core` or `packages/api`. The rule is enforced mechanically: a
`no-restricted-imports` override in `vite.config.ts` (files `packages/core/**`,
`packages/api/**`) bans `@marimo-hub/{storage,compute,auth,credentials,secrets}-*`
imports, and a colocated `package-dependencies.test.ts` in each of `core` and
`api` fails if an adapter appears in their `package.json`.

## Conventions

- **Formatting** (from `.oxfmtrc.json`): tabs for indentation, single quotes,
  semicolons, `printWidth: 100`, `trailingComma: all`. Run `pnpm check` (or
  `vp fmt`) before finishing; CI fails on unformatted files.
- **Tests** are colocated `*.test.ts` files using **vitest**, with the
  `MemoryBucket` test double imported from `@marimo-hub/core/testing`. Reusable
  conformance suites live at `@marimo-hub/core/testing/contract` (`bucketContract`,
  run by every storage adapter) and `@marimo-hub/core/testing/compute-contract`
  (`computeContract`, run by the hermetic compute adapters). Result-envelope
  assertions (`expectExecResult`, `expectFileResult`) are exported from
  `@marimo-hub/core/testing` — prefer them over hand-rolled `{ success, … }` checks.
- **API response envelope** is always `{ success: true, data }` or
  `{ success: false, error: { code, message } }` (see `packages/api/src`). Sole
  exception: routes serving raw content (e.g. the notebook HTML snapshot at
  `GET …/notebooks/{nid}/html`) return the bytes directly on success; their
  errors still use the envelope.
- **Committed specs.** `packages/api/openapi.yaml` and
  `internal/schemas/{bucket,integrations}.yml` are generated from the zod
  schemas; drift tests fail the build when they are stale. Regenerate with
  `pnpm schemas:generate`. CI diffs each spec against `main` with oasdiff and
  fails on breaking changes. See `internal/schemas/README.md`.
- **Frontend** (`packages/web`) is a React 19 SPA using Tailwind v4
  (`@tailwindcss/vite`) with shadcn-style UI (`class-variance-authority`,
  `clsx`, `tailwind-merge`, `lucide-react`, `sonner`) plus
  `react-aria-components`, TanStack Query, and React Router. Helpers live in
  `src/lib/utils.ts`; theming in `src/context/ThemeContext.tsx`; UI primitives in
  `src/components/ui/`. It is plain CSS **no longer** — use Tailwind utilities.

## Workflow

- **Final task: remove AI slop comments.** Always add a to-do item to the end of
  your task list to review your changes and strip AI-slop comments — verbose
  restatements of what the code plainly does, narration of the change ("now we
  also…"), or obvious-from-signature doc blocks. Keep only comments that explain
  _why_ (non-obvious intent, invariants, gotchas), matching the surrounding
  style.

## Key invariant

`_system/catalog.json` (see `packages/core/src/paths.ts`) is the only mutable
pointer in the catalog snapshot chain. All writes to this object go through
`CatalogService.mutateSnapshot`
(`packages/core/src/services/catalog/CatalogService.ts`). This method uses an
ETag compare-and-swap (conditional PUT) with retries.

These CAS-managed records also have one writer each:

- `SessionService` owns each editor claim at
  `_system/editors/{pid}/{nid}.json`.
- `SessionService.claimApp`/`releaseApp` owns each app claim at
  `_system/apps/{pid}/{nid}.json`.
- `ProjectIntegrationsStore` owns each project integration head at
  `projects/{pid}/integrations/{iid}/integration.json`.
- `OrgIntegrationsStore` owns each org integration head at
  `_system/integrations/{iid}/integration.json`.

Each integration store also owns its immutable `versions/{n}.json` history and
its `integrations/_names/{name}.json` uniqueness claim. Version writes use
create-if-absent. Name claims use the same pattern as app claims.

Deleting a notebook or project can delete its subordinate claims and objects as
cleanup. Everything else is immutable, append-only, or an operational record,
such as a session, identity, token, or secret. Do not bypass the owners listed
above.
See [`development_docs/bucket_spec.md`](./development_docs/bucket_spec.md).

## Outstanding work

See [`plans/`](./plans) for planned changes and their status.
