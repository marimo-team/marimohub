# Idempotent creates

`POST` creates aren't naturally idempotent — a retry after a dropped response can
create a duplicate. Send an optional `Idempotency-Key` header (a unique value per
create, reused verbatim on retries) and the server replays the original result:

```
POST /api/v1/projects
Idempotency-Key: 8f3c1e2a-...

→ 201 { success, data: { id: "proj-…" } }   # first use: created
→ 201 { same body }                          # replay: no new project
```

- **Create routes** — `POST /projects` and `POST …/notebooks` accept the header.
  `POST …/sessions` accepts it but already reuses a session for `(user, notebook)`.
- **External delivery** — `POST …/alert-destinations/{aid}/test` requires the header because it sends a real message.
- **Scope** — keyed by `(user, route, key)`. The route includes concrete project, notebook, and job ids.
  A different user or resource starts a separate operation. The header is optional.
- **Payload** — HTTP create routes store a SHA-256 fingerprint of the request body.
  JSON object key order does not affect the fingerprint.
  If a retry changes the payload, the server returns `422 VALIDATION_ERROR`.
  HTTP create records without a fingerprint return `422 VALIDATION_ERROR` because
  the server cannot verify their original payload. The server also checks the old
  route-template scope for parametrized routes and rejects a matching legacy key.
  This prevents an upgrade from silently treating an old retry as a new create.
  Check whether the original operation succeeded before submitting a new key.
- **Deletion** — deleting a resource does not erase its recorded response.
  A retry returns that response without recreating the resource. A new create requires a new key.
- **Mechanics** — the first response's `data` is stored at
  `_system/idempotency/{sha256(user:route\nkey)}.json` with create-if-absent.
  A hit replays it. See `IdempotencyService` (core) and `idempotentCreate` (api).
- **External delivery mechanics** — deterministic checks run first. The server then admits a refundable test-budget entry before it stores a separate delivery claim.
  If claim storage fails or another request owns the claim, the server refunds the budget entry.
  Only the claim owner keeps the budget charge and attempts delivery.
  A completed test stores its response under the result scope.
  A concurrent or uncertain request cannot send the message again with the same key.
- **Retention** — pruned after 24h by the maintenance cron, so replay is
  guaranteed only within that window.
- **Create concurrency** — two requests with the same unused key can both create before either request stores its response.
  The first stored response wins. Later requests replay that response.
