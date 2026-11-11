# @marimo-hub/vite-config

Shared Vite+ configuration for workspace packages.

- `libraryConfig(overrides?)` — defaults for a buildable package: `pack.dts`,
  `test.include = src/**/*.test.ts`, the threads pool, and the cacheable
  `test:vitest` task. Overrides are shallow-merged per section, except that an
  array `pack` override replaces the `pack` defaults.
- `testTasks` — the `test:vitest` task alone, for bespoke configs such as
  `packages/web`, `apps/server`, `apps/docs`, and `examples/cloudflare-worker`.
- `vitestTaskCache` — the task's cache settings, for a differently named task
  that also runs Vitest (the repository root's `test:root:vitest`).

Every workspace package's `test` script is `vp run test:vitest`. The task excludes
Vitest's on-disk caches from Vite Task's input/output tracking; without that,
Vite Task refuses to cache a run that touched one of Vitest's `.tmp-*` files, so
`pnpm test` re-ran unchanged packages. It also fingerprints the environment
variables that opt tests in (`MARIMOHUB_*`, `MARIMO_*`, `APP_PERFORMANCE_REPORT`,
`UPDATE_*`, …), so a run made without one is not replayed once it is set.

```ts
// vite.config.ts
import { libraryConfig } from '@marimo-hub/vite-config';

export default libraryConfig();
```
