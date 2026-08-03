# Production dependency audit

Run `pnpm audit:prod` before a release. CI runs the same command. The command fails for each
unapproved high or critical advisory in production dependencies.

The allowlist is in `scripts/audit-production.mjs`. Each entry must identify one GitHub Security
Advisory and state why the affected code is not used.

## Current exception

`GHSA-qwww-vcr4-c8h2` affects the unstable React Server Components APIs in React Router. The web
package is a client-rendered Vite SPA. It does not use React Server Components or server actions.
React Router has not published the patched 8.3 release. Remove this exception when that release is
available and the web package can upgrade.
