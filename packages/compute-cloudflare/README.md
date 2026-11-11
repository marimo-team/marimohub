# @marimo-hub/compute-cloudflare

Compute adapter running kernel sandboxes on Cloudflare Sandboxes (`@cloudflare/sandbox`).

Part of [marimohub](../../README.md). See [docs/compute.md](../../docs/compute.md) for configuration.

Orphan cleanup stops the runtime with `SIGKILL` and confirms a stopped state within ten seconds.
Failed or uncertain shutdowns retain the app-pool member for retry. Durable Object metadata remains.
Cleanup does not call SDK `destroy()`, whose mount-cleanup commands can wake a stopped container.
