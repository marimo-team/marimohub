# Plan 011: Keep React Query Devtools out of the production bundle

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update this plan's status
> row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- packages/web/src/main.tsx packages/web/package.json`
> If either changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: migration / perf
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

`@tanstack/react-query-devtools` is listed under **`dependencies`** (not
`devDependencies`) and imported + rendered unconditionally in `main.tsx`. The
devtools component renders nothing in production builds, but the module is still
bundled and shipped to every user (tens of KB of gzipped JS that does nothing in
prod). Moving it to a dev-only dependency and a conditional import removes it
from the production bundle and keeps the dependency manifest honest.

## Current state

**`packages/web/src/main.tsx`**:

```tsx
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
// ...
createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<App />
			<ReactQueryDevtools initialIsOpen={false} />
		</QueryClientProvider>
	</StrictMode>,
);
```

**`packages/web/package.json`** — `@tanstack/react-query-devtools` is under
`dependencies`. Vite is the bundler; `import.meta.env.DEV` is `true` in dev,
`false` in the production build, and Vite tree-shakes branches guarded by it.

## Commands you will need

| Purpose   | Command                              | Expected |
| --------- | ------------------------------------ | -------- |
| Install   | `pnpm install`                       | exit 0   |
| Web build | `pnpm --filter @marimo-hub/web build` | exit 0   |
| Check     | `pnpm check`                         | exit 0   |

## Scope

**In scope**:

- `packages/web/src/main.tsx` — conditionally import/render devtools only in dev.
- `packages/web/package.json` — move `@tanstack/react-query-devtools` to
  `devDependencies`.

**Out of scope**: anything else in `packages/web`; the `QueryClient` config.

## Git workflow

- Branch: `advisor/011-devtools-prod`
- Commit message: `Load React Query devtools only in dev`.

## Steps

### Step 1: Make the devtools dev-only in `main.tsx`

Use a dynamic, dev-gated import so the module is excluded from the production
bundle. One robust pattern:

```tsx
import { StrictMode, lazy, Suspense } from 'react';
// ...
const ReactQueryDevtools = import.meta.env.DEV
	? lazy(() =>
			import('@tanstack/react-query-devtools').then((m) => ({
				default: m.ReactQueryDevtools,
			})),
		)
	: () => null;

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<App />
			{import.meta.env.DEV && (
				<Suspense fallback={null}>
					<ReactQueryDevtools initialIsOpen={false} />
				</Suspense>
			)}
		</QueryClientProvider>
	</StrictMode>,
);
```

(The key property: the `import('@tanstack/react-query-devtools')` is reached only
under `import.meta.env.DEV`, so the production build tree-shakes it out.)

**Verify**: `pnpm --filter @marimo-hub/web build` exits 0.

### Step 2: Move the dependency to devDependencies

In `packages/web/package.json`, move `@tanstack/react-query-devtools` from
`dependencies` to `devDependencies` (same version). Run `pnpm install`.

**Verify**: `pnpm install` exits 0; `node -e "const p=require('./packages/web/package.json'); if(p.dependencies && p.dependencies['@tanstack/react-query-devtools']) process.exit(1)" && echo OK` → `OK`.

### Step 3: Confirm dev still shows devtools and prod excludes it

- Dev: `pnpm --filter @marimo-hub/web dev` boots and the devtools toggle is
  present (manual check, optional).
- Prod: build and confirm the devtools module is not in the output. If the build
  emits a bundle stats/listing, grep it; otherwise grep the `dist/assets/*.js`
  for a devtools marker:
  `! grep -rl "react-query-devtools\|ReactQueryDevtoolsPanel" packages/web/dist/assets 2>/dev/null` → no match (command succeeds = string absent).

**Verify**: the production `dist` does not contain devtools code (grep above
finds nothing).

## Test plan

- No unit tests (build-config change). The verification is the production build
  excluding the module (Step 3) and dev still rendering it.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `@tanstack/react-query-devtools` is in `devDependencies`, not
      `dependencies`, in `packages/web/package.json`.
- [ ] The devtools import in `main.tsx` is reached only under
      `import.meta.env.DEV`.
- [ ] `pnpm --filter @marimo-hub/web build` exits 0 and the output contains no
      devtools code.
- [ ] `pnpm check` exits 0.
- [ ] No files outside the in-scope list modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The web build fails to tree-shake the dev-gated dynamic import (devtools code
  still appears in `dist`) — report the bundler behavior; do not ship it in prod
  regardless.
- Moving to `devDependencies` breaks the build because something else imports it
  unconditionally — find that import and gate it too, or report.

## Maintenance notes

- This pattern (`import.meta.env.DEV` + dynamic import) is the template for any
  future dev-only tooling added to the SPA.
- A reviewer should confirm the production bundle size dropped (compare
  `dist/assets` sizes before/after if a stats output is available).
