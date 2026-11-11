# @marimo-hub/vite-config

Shared Vite+ configuration for workspace packages.

- `libraryConfig(overrides?)` — defaults for a buildable package: `pack.dts`,
  `test.include = src/**/*.test.ts`, the threads pool, and the cacheable
  `test:vitest` task. Overrides are shallow-merged per section.
- `testTasks` — the `test:vitest` task alone, for packages with bespoke configs
  (`packages/web`, `apps/server`).

Every package's `test` script is `vp run test:vitest`. The task excludes
Vitest's on-disk caches from Vite Task's input/output tracking; without that,
Vite Task refuses to cache a run that touched one of Vitest's `.tmp-*` files, so
`pnpm test` re-ran unchanged packages.

```ts
// vite.config.ts
import { libraryConfig } from '@marimo-hub/vite-config';

export default libraryConfig();
```
