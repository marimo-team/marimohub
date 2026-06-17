# Contributing

Thanks for helping improve marimohub. This repository is still early, so small,
well-scoped changes with clear verification are the easiest to review.

## Before you start

- Read [README.md](./README.md) for the project shape.
- Read [development_docs/architecture.md](./development_docs/architecture.md) for
  the ports-and-adapters boundary.
- Report suspected vulnerabilities through [SECURITY.md](./SECURITY.md), not a
  public issue.

## Set up

Requirements:

- Node >= 22.12
- pnpm 10.20.0
- `uv` and Python if you run local notebook kernels

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` runs the local memory, local compute, and dev auth stack. See
[docs/testing-locally.md](./docs/testing-locally.md) for the full local path.

## Verify changes

Run the smallest useful command while you work, then run the full gates before a
pull request:

```bash
pnpm check
pnpm test
pnpm build
```

For docs-only changes, also run:

```bash
pnpm --filter @marimo-hub/docs test
pnpm --filter @marimo-hub/docs build
```

Generated docs must stay generated. If you change configuration registry data,
regenerate the configuration reference:

```bash
pnpm --filter @marimo-hub/config docs:generate
```

## Architecture guardrails

- `packages/core` owns domain models, services, and port interfaces. It must not
  import vendor SDKs.
- `packages/api` wires services to Hono/OpenAPI routes. It must not import
  concrete storage, compute, or auth adapters.
- Adapter packages implement core ports.
- `packages/config` is the package that imports concrete adapters and selects
  them from `MARIMOHUB_*` configuration.
- `_system/catalog.json` is the only object mutated in place, and writes must go
  through `CatalogService.mutateSnapshot`.

## Documentation changes

Docs are operator-first: help someone evaluate, configure, deploy, operate, or
troubleshoot marimohub. Use [docs/contributing/docs-style.md](./docs/contributing/docs-style.md)
for page types, tone, generated-doc rules, and examples.

Keep docs concise. Link to generated reference material instead of copying long
tables by hand.

## Contributor License Agreement

First-time contributors are asked to sign the
[marimo CLA](https://marimo.io/cla) — a bot will prompt you on your first pull
request.

## Pull requests

- Keep changes focused.
- Include tests or explain why tests do not apply.
- Update docs when behavior, configuration, or operator workflow changes.
- Note any skipped verification commands and why.
- Before you finish, remove comments or prose that only restate what the code or
  heading already says.
