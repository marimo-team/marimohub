# Idempotent creates

> **Status:** implemented (plan 033).

`POST` creates aren't naturally idempotent — a retry after a dropped response can
create a duplicate. Send an optional `Idempotency-Key` header (a unique value per
create, reused verbatim on retries) and the server replays the original result:

```
POST /api/v1/projects
Idempotency-Key: 8f3c1e2a-...

→ 201 { success, data: { id: "proj-…" } }   # first use: created
→ 201 { same body }                          # replay: no new project
```

- **Routes** — `POST /projects` and `POST …/notebooks`. `POST …/sessions`
  accepts the header but is already idempotent on `(user, notebook)` via its
  create-or-reuse path, so it needs no store.
- **Scope** — keyed by `(user, route, key)`; a different user or route is a
  distinct first use. The header is optional (omit it for today's behavior).
- **Mechanics** — the first response's `data` is stored at
  `_system/idempotency/{sha256(user:route\nkey)}.json` with create-if-absent; a
  hit replays it. See `IdempotencyService` (core) + `idempotentCreate` (api).
- **Retention** — pruned after 24h by the maintenance cron, so replay is
  guaranteed only within that window.
- **Concurrency** — no cross-replica lock: two requests racing on the _same
  unused_ key can both create (a small, documented window). A retry after the
  first response is recorded always replays.
