# Plan 012: Fix documentation that no longer matches the code (package layout & file paths)

> **Executor instructions**: Follow this plan step by step. Verify each change
> against the real repo. If a STOP condition occurs, stop and report. When done,
> update this plan's status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- docs/architecture.md docs/technologies.md`
> If either doc changed since this plan was written, re-derive the corrections
> from the live tree before editing.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (docs only)
- **Depends on**: none (but do after 001 so CLAUDE.md/README exist to cross-link)
- **Category**: docs
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

The architecture docs describe an _intended_ package decomposition that the
actual repo only partly matches. A new contributor or agent following the docs
will look for packages and files that don't exist, building a wrong mental model
of the codebase. Stale docs are worse than missing docs. These are precise,
verifiable corrections.

## Current state (the specific drifts — verify each against the live tree)

**`docs/architecture.md §7 "Monorepo & Packages"`** (around lines 372–404) lists
a `packages/`/`apps/` tree that includes:

- `packages/source-github/` — **does not exist**. The GitHub source type's schema
  lives in `packages/core/src/schema.ts` (`GithubSourceSchema`) and is _not yet
  implemented_ (resolver throws "not yet implemented"); there is no separate
  package.
- `apps/worker/` — **does not exist**. The Cloudflare Workers entrypoint is
  `examples/cloudflare-worker/`. The only thing under `apps/` is `apps/server/`.
- `@marimo-hub/server-node` — the Node entrypoint package is named
  `@marimo-hub/server` (`apps/server`), not `server-node`.

The section already carries a parenthetical that the layout is "intended" /
"describes the intended package decomposition" — but it still names
non-existent packages as if present.

**`docs/technologies.md`** references a pre-split `worker/` layout:

- `worker/schema.ts` (e.g. around lines 28 and 80) — the zod schemas are at
  `packages/core/src/schema.ts`.
- `worker/` paths and `worker-configuration.d.ts`, and a
  `tsconfig.app/worker/node.json` split — the real configs are root `tsconfig.json`
  plus per-package `packages/*/tsconfig.json`; `wrangler.jsonc` lives under
  `examples/cloudflare-worker/`.

**Verify the actual tree before editing**:
`find packages apps -maxdepth 1 -type d | sort` and
`find . -name 'tsconfig*.json' -not -path '*/node_modules/*'` give the ground
truth. The real package list is: `packages/{core,api,config,storage-s3,storage-r2,compute-cloudflare,compute-modal,auth-oidc,auth-cloudflare-access,auth-dev,web,client}`,
`apps/server`, `examples/{cloudflare-worker,docker-compose,library-composition}`.

## Commands you will need

| Purpose           | Command                                                                                         | Expected         |
| ----------------- | ----------------------------------------------------------------------------------------------- | ---------------- |
| Ground-truth tree | `find packages apps examples -maxdepth 1 -type d \| sort`                                       | the real list    |
| Find stale refs   | `grep -rn "source-github\|apps/worker\|server-node\|worker/schema\|worker-configuration" docs/` | the lines to fix |

## Scope

**In scope**: `docs/architecture.md`, `docs/technologies.md` (text only).

**Out of scope** (do NOT touch):

- Any code, schema, or config — this plan only corrects prose.
- `docs/bucket_spec.md` — it is accurate; leave it.
- Do NOT "fix" the docs by _building_ the missing packages — that is a separate
  direction item (GitHub source type). Here you only make the docs describe
  reality.

## Git workflow

- Branch: `advisor/012-docs-drift`
- Commit message: `docs: correct package layout and file paths to match the code`.

## Steps

### Step 1: Correct `architecture.md §7`

Update the package/app tree to the **real** layout (from the ground-truth
command). Specifically:

- Remove `source-github/` from the package list; replace with a note that the
  GitHub source type is _designed but not yet implemented_ — its schema is in
  `packages/core/src/schema.ts` and resolution is deferred (link the relevant
  open question in `bucket_spec.md`).
- Replace `apps/worker/` with: Cloudflare Workers entrypoint lives in
  `examples/cloudflare-worker/`; the only `apps/` entry is `apps/server/`.
- Replace `@marimo-hub/server-node` with `@marimo-hub/server` (`apps/server`).
- Keep the "ports point inward" narrative (it is accurate).

If the section frames the whole tree as aspirational, reframe it to clearly
separate **what exists today** from **what is intended later** (e.g. a short
"current vs. planned" note), so no reader mistakes the planned `source-github`
split for an existing package.

**Verify**: `grep -n "source-github\|apps/worker\|server-node" docs/architecture.md`
returns no matches that present them as existing packages (a clearly-labeled
"planned" mention of the github source type is fine).

### Step 2: Correct `technologies.md`

- Replace `worker/schema.ts` references with `packages/core/src/schema.ts`.
- Replace generic `worker/` path references with the real locations: the API/Hono
  code is in `packages/api`; the Node entrypoint is `apps/server`; the Workers
  entrypoint + `wrangler.jsonc` are in `examples/cloudflare-worker`.
- Fix the TypeScript-config description: root `tsconfig.json` + per-package
  `packages/*/tsconfig.json` (not `tsconfig.app/worker/node.json`).
- Keep all genuinely-accurate technology descriptions (Hono, zod, jose, ulidx,
  React 19, Vite, oxlint/oxfmt, vitest, etc.) unchanged.

**Verify**: `grep -n "worker/schema\|worker-configuration\|tsconfig.app.json" docs/technologies.md`
returns no matches.

### Step 3: Sanity-check every path the docs now claim

For each file/dir path the edited docs reference, confirm it exists:
`grep -oE "(packages|apps|examples)/[A-Za-z0-9/_.-]+" docs/architecture.md docs/technologies.md | sort -u`
then spot-check that each resolves (`test -e <path>`). Fix any remaining
mismatch.

**Verify**: every code path referenced in the two docs exists on disk (or is
explicitly labeled "planned/not yet built").

## Test plan

- No code tests. Verification is grep-based (Steps 1–3) plus a manual read for
  coherence.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `docs/architecture.md` no longer presents `source-github`, `apps/worker`,
      or `@marimo-hub/server-node` as existing.
- [ ] `docs/technologies.md` no longer references `worker/schema.ts`,
      `worker-configuration.d.ts`, or the `tsconfig.app/worker/node.json` split.
- [ ] Every `packages|apps|examples` path referenced in the two docs exists on
      disk (or is clearly labeled "planned").
- [ ] No non-doc files modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The real tree differs from the list in "Current state" (packages added/renamed
  since this plan) — re-derive from the ground-truth command and use that; note
  the difference.
- A doc statement is wrong in a way that implies a _code_ bug (not just stale
  prose) — report it as a separate finding rather than papering over it in docs.

## Maintenance notes

- When the GitHub source type or a real Workers `apps/` entrypoint is built,
  revisit these sections so "planned" becomes "current".
- Consider adding a CI check (or a note in CLAUDE.md) that doc-referenced paths
  must exist, to prevent re-drift.
