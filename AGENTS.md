# AGENTS.md

Guidance for coding agents working in this repository (a pnpm + vite-plus
TypeScript monorepo for MarimoHub). Read this before making changes.

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
  It imports **no vendor SDK** (its only deps are `ulidx` and `zod`).
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
`packages/core` or `packages/api`.

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
  `{ success: false, error: { code, message } }` (see `packages/api/src`).
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

`_system/catalog.json` (see `packages/core/src/paths.ts`) is the only object
mutated in place. All writes to it go through `CatalogService.mutateSnapshot`
(`packages/core/src/services/catalog/CatalogService.ts`), which performs a
compare-and-swap on the object's ETag (conditional PUT) with retry. Everything
else in the store is immutable or append-only. Do not write the catalog pointer
by any other path. See [`development_docs/bucket_spec.md`](./development_docs/bucket_spec.md).

## Outstanding work

See [`plans/`](./plans) for planned changes and their status.
