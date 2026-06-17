# @marimo-hub/tsconfig

Shared TypeScript configuration for the monorepo. Every package's
`tsconfig.json` extends one of these instead of re-declaring the full compiler
options.

## Configs

| File           | Extends | Use for                                                                               |
| -------------- | ------- | ------------------------------------------------------------------------------------- |
| `base.json`    | —       | The modern defaults: no-emit type checking, `strict`, bundler resolution, `ts-reset`. |
| `library.json` | `base`  | Buildable packages (`vp pack`) that emit declarations.                                |

Leaf configs override only what differs (e.g. `@cloudflare/workers-types`,
React `jsx`/`lib`, `vite/client`). When a leaf overrides `types`, it must
re-list `@marimo-hub/tsconfig/ts-reset` — TS replaces array options on extend
rather than merging them.

```jsonc
// a library package
{ "extends": "@marimo-hub/tsconfig/library.json", "include": ["src"] }

// a node app / example
{ "extends": "@marimo-hub/tsconfig/base.json", "include": ["src"] }
```

`extends`/`types` resolve via node resolution, so every consumer lists
`"@marimo-hub/tsconfig": "workspace:*"` in `devDependencies`.

## `ts-reset.d.ts`

A trimmed vendoring of [`@total-typescript/ts-reset`](https://github.com/mattpocock/ts-reset)
(MIT, Matt Pocock), injected globally via `base.json`'s
`types: ["@marimo-hub/tsconfig/ts-reset"]`. Only the bug-catching subset is
kept; the upstream literal-widening helpers are dropped on purpose.

| Rule                           | Vendored | Upstream entrypoint             |
| ------------------------------ | -------- | ------------------------------- |
| `JSON.parse` → `unknown`       | ✅       | `json-parse.d.ts`               |
| `Body.json()` → `unknown`      | ✅       | `fetch.d.ts`                    |
| `.filter(Boolean)` narrows     | ✅       | `filter-boolean.d.ts`           |
| `Array.isArray` → `unknown[]`  | ✅       | `is-array.d.ts`                 |
| `Array.includes` widening      | ❌       | `array-includes.d.ts`           |
| `Set.has` / `Map.has` widening | ❌       | `set-has.d.ts` / `map-has.d.ts` |

To update, re-fetch the upstream entrypoints and re-apply by hand — the file is
small on purpose. If a rule flags a real bug, fix the bug; only comment the rule
out if it's a false positive.
