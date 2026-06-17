# Plan 001: Establish the verification baseline — CI, root README, CLAUDE.md, and a typecheck script

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- package.json pnpm-workspace.yaml .github`
> If `package.json` or the workspace config changed since this plan was written,
> compare the "Current state" excerpts against the live files before proceeding;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

This repo has **no CI, no root README, no CLAUDE.md, and no standalone
typecheck script**, and `node_modules` is not committed. Every other plan in
this set will be executed by a _separate agent with zero context_, and each one
ends in verification commands (`pnpm install`, `pnpm test`, `pnpm check`). If
there is no documented, working one-command verification path and no CI gate,
those agents cannot confirm their work, and broken changes can land unnoticed.
This plan creates the safety net the rest depend on. It is intentionally first.

## Current state

- **`package.json`** (root) — `marimohub`, private, pnpm workspace. Scripts today:
  ```json
  "scripts": {
    "ready": "vp fmt && vp lint && vp run -r test && vp run -r build",
    "check": "vp check",
    "test": "vp run -r test",
    "build": "vp run -r build",
    "prepare": "vp config"
  }
  ```
  `engines.node` is `>=22.12.0`; `packageManager` is `pnpm@10.20.0`. The tooling
  is **vite-plus** (`vp`): `vp check` typechecks + lints, `vp fmt` formats,
  `vp run -r test` runs every package's `test` script, `vp run -r build` builds.
- **No `.github/` directory exists** (confirmed: `ls .github` → not found).
- **No root `README.md`, `CLAUDE.md`, or `AGENTS.md`.** Documentation lives only
  in `docs/architecture.md`, `docs/technologies.md`, `docs/bucket_spec.md`.
- **`pnpm-lock.yaml` exists and is committed** (~105 KB), so CI can install with
  `--frozen-lockfile`.
- Package layout (actual, verified): `packages/{core,api,config,storage-s3,storage-r2,compute-cloudflare,compute-modal,auth-oidc,auth-cloudflare-access,auth-dev,web,client}`, `apps/server`, `examples/{cloudflare-worker,docker-compose,library-composition}`. Package names are `@marimo-hub/<dir>` except `apps/server` = `@marimo-hub/server`.
- Test runner is **vitest** (via `vp test`); 15 colocated `*.test.ts` files exist today (in `core`, `api`, `storage-s3`).

> Note: do NOT claim a structure that does not exist. The package list above is
> the real one — `docs/architecture.md §7` describes an _intended_ layout that
> drifts from reality (a separate plan, 012, fixes that doc). Write CLAUDE.md
> against the **actual** tree above.

## Commands you will need

| Purpose                | Command                          | Expected on success |
| ---------------------- | -------------------------------- | ------------------- |
| Install                | `pnpm install --frozen-lockfile` | exit 0              |
| Check (typecheck+lint) | `pnpm check`                     | exit 0, no errors   |
| Tests                  | `pnpm test`                      | all pass            |
| Build                  | `pnpm build`                     | exit 0              |

(These are the repo's real commands, verified during recon. `pnpm check` runs
`vp check`.)

## Scope

**In scope** (the only files you should create/modify):

- `README.md` (create)
- `CLAUDE.md` (create)
- `.github/workflows/ci.yml` (create)
- `package.json` (add one script only — see Step 4)

**Out of scope** (do NOT touch):

- Any `packages/**` or `apps/**` source or config.
- `vite.config.ts`, `.oxlintrc.json`, `.oxfmtrc.json` — leave the toolchain config alone.
- Do not add pre-commit hooks (vite-plus already wires staged checks via the
  `prepare: vp config` script — adding husky would conflict).

## Git workflow

- Branch: `advisor/001-repo-foundation`
- One commit is fine; message style (match `git log`): a plain imperative
  subject line, e.g. `Add CI workflow, README, and CLAUDE.md`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create `.github/workflows/ci.yml`

Create a GitHub Actions workflow that installs with the frozen lockfile and runs
the existing scripts. Use pnpm's official action and Node 22.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.20.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - run: pnpm test
      - run: pnpm build
```

**Verify**: `test -f .github/workflows/ci.yml && echo OK` → prints `OK`. The file
parses as YAML: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo YAML_OK` → prints `YAML_OK`. (If `python3`/PyYAML is unavailable, skip the YAML check.)

### Step 2: Create root `README.md`

Write a concise (~120–200 line) README. It MUST contain, accurately:

- One-paragraph description: MarimoHub is a self-hostable, provider-agnostic
  platform for storing and running [marimo](https://marimo.io) notebooks, built
  as ports-and-adapters with **no database** (object storage is the single
  source of truth). Link to `docs/architecture.md`.
- **Quickstart** that actually works:
  ```bash
  pnpm install
  pnpm check     # typecheck + lint
  pnpm test      # run all package tests
  pnpm build     # build all packages
  ```
  Note `Node >= 22.12` and `pnpm 10.20.0` (from `package.json`).
- A **local dev** note: copy `apps/server/.env.example` to `.env`, set
  `MARIMOHUB_STORAGE_BACKEND=memory`, `MARIMOHUB_COMPUTE_BACKEND=none`,
  `MARIMOHUB_AUTH_BACKEND=dev` for a zero-dependency local run (cross-reference
  `docs/architecture.md §4` for the full `MARIMOHUB_*` surface).
- A **package map** table generated from the real tree (the list in "Current
  state"), one line each on what the package does.
- Links to the three docs in `docs/`.

Do not invent commands, packages, or env vars beyond those documented in
`docs/architecture.md` and `apps/server/.env.example`.

**Verify**: `test -f README.md && grep -q "pnpm install" README.md && echo OK` → `OK`.

### Step 3: Create `CLAUDE.md`

Write a CLAUDE.md aimed at coding agents working in this repo. It MUST include:

- **Build/test/lint commands** (the table above) — agents read this first.
- **Architecture in 5 bullets**: ports-and-adapters; `packages/core` holds the
  domain + port interfaces and imports **no vendor SDK**; adapters
  (`storage-*`, `compute-*`, `auth-*`) implement the ports; `packages/api` wires
  services to Hono/OpenAPI routes; `packages/config` is the ONLY package that
  imports concrete adapters; entrypoints are `apps/server` (Node) and
  `examples/cloudflare-worker` (Workers).
- **The dependency rule**: dependencies point inward only — `core` and `api`
  never import an adapter; adapters depend on `core`'s interfaces. Reviewers
  should reject PRs that violate this.
- **Conventions**: tabs for indentation, single quotes, semicolons,
  `printWidth: 100`, `trailingComma: all` (from `.oxfmtrc.json`); tests are
  colocated `*.test.ts` using vitest + `MemoryBucket` from
  `@marimo-hub/core/testing`; the API response envelope is always
  `{ success: true, data }` or `{ success: false, error: { code, message } }`.
- **Key invariant**: `_system/catalog.json` is the only mutated-in-place object;
  writes go through `CatalogService.mutateSnapshot` (compare-and-swap on ETag).
  See `docs/bucket_spec.md`.
- A pointer to `plans/` for outstanding work.

**Verify**: `test -f CLAUDE.md && echo OK` → `OK`.

### Step 4: Add a `typecheck` alias script to `package.json`

In the root `package.json` `scripts` block, add one line so type-only checking
is discoverable (it currently hides inside `vp check`):

```json
"typecheck": "vp check"
```

Keep all existing scripts unchanged. (vite-plus does not expose a separate
type-only command; aliasing to `vp check` is the honest mapping. If, on
inspection, `vp` exposes a dedicated typecheck subcommand, prefer that and note
it in the PR description.)

**Verify**: `node -e "const s=require('./package.json').scripts; if(!s.typecheck) process.exit(1)" && echo OK` → `OK`.

### Step 5: Confirm the baseline actually runs

This is the whole point of the plan — prove the documented commands work.

**Verify**:

- `pnpm install --frozen-lockfile` → exit 0.
- `pnpm check` → exit 0.
- `pnpm test` → all tests pass.
- `pnpm build` → exit 0.

If any of these fail for reasons unrelated to your edits (i.e. the repo did not
build before you started), see STOP conditions.

## Test plan

- No new unit tests (this plan adds docs + CI, no source logic).
- The verification _is_ running the existing suite (Step 5). The CI workflow
  encodes that suite as the permanent gate.
- After this lands, every later plan can rely on `pnpm check && pnpm test` as
  its done-criteria backbone.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/ci.yml` exists and is valid YAML.
- [ ] `README.md` exists and contains a working `pnpm install` quickstart.
- [ ] `CLAUDE.md` exists with the commands table and the dependency rule.
- [ ] `package.json` has a `typecheck` script; all prior scripts unchanged
      (`git diff package.json` shows only an addition).
- [ ] `pnpm install --frozen-lockfile && pnpm check && pnpm test && pnpm build` all exit 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- `pnpm install --frozen-lockfile` fails (lockfile out of sync with manifests) —
  report the error; do NOT regenerate the lockfile as part of this plan.
- `pnpm check`, `pnpm test`, or `pnpm build` fails **before** any of your edits
  (run them once at the start to establish the pre-existing state). If the
  baseline is already red, that is a finding in itself — report which command
  failed and its output, and do not paper over it with doc changes.
- You discover the package tree differs from "Current state" (packages added or
  renamed) — the README/CLAUDE.md map would be wrong; re-derive it and note it.

## Maintenance notes

- When packages are added/removed, update the package map in both README.md and
  CLAUDE.md, and confirm CI still passes.
- If the team later adopts a matrix (multiple Node versions) or a separate
  lint/test split, extend `ci.yml` — keep `--frozen-lockfile` so CI fails on
  lockfile drift rather than silently resolving new versions.
- A reviewer should confirm the CLAUDE.md "dependency rule" matches reality and
  that no invented commands slipped into the README.
