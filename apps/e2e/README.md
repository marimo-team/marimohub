# @marimo-hub/e2e

Browser end-to-end tests (Playwright) run against the in-memory/dev-auth stack.

CI runs the suite on chromium, firefox, and webkit (one matrix job each).
Locally `pnpm e2e` runs chromium only; to run another browser, install it
(`pnpm exec playwright install --with-deps firefox`) and select it with
`E2E_BROWSER=firefox pnpm e2e` (comma-separate to run several).

Part of [marimohub](../../README.md).
