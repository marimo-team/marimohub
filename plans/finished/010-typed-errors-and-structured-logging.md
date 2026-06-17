# Plan 010: Map infrastructure/not-found failures to typed HTTP codes and add structured, contextful logging

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update this plan's status
> row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- packages/core/src/errors.ts packages/core/src/services/CatalogService.ts packages/core/src/services/SandboxProvisioner.ts packages/api/src/createApi.ts apps/server/src`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (error-code mapping changes responses for currently-500 cases; logging is additive)
- **Depends on**: 001 (verification baseline)
- **Category**: tech-debt / dx
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

Two related observability gaps:

1. **Operational failures surface as opaque 500s.** `CatalogService` throws a
   generic `Error('Catalog not found — call initialize() first')` /
   `Error('Snapshot … not found')`, and `SandboxProvisioner` throws a generic
   `Error('Sandbox container is not available …')`. The API error handler only
   maps the typed domain errors; everything else becomes `500 INTERNAL_ERROR`. So
   "storage not initialized", "snapshot missing", and "compute backend down" are
   indistinguishable from real bugs — clients and on-call can't triage.
2. **Logs have no context.** Every error is `console.error(err)` with no request
   id, route, user, or operation. Across replicas this is untraceable.

This plan adds two error subtypes and a minimal structured logger, and threads
request context into the API error handler.

## Current state

**`packages/core/src/errors.ts`** — has `PreconditionFailedError` (412),
`NotFoundError` (404), `ConflictError` (409), `ForbiddenError` (403), each with a
`readonly status` and a `name`.

**`packages/core/src/services/CatalogService.ts`** — generic throws at lines
~47, ~53, ~67, ~75: `throw new Error('Catalog not found — call initialize() first')`
and `throw new Error(\`Snapshot ${...} not found\`)`.

**`packages/core/src/services/SandboxProvisioner.ts`** — lines ~46–51:
`throw new Error(\`Sandbox container is not available. Is Docker running? ...\`)`.

**`packages/api/src/createApi.ts`** — `app.onError` (lines ~55–76) maps
`NotFoundError`/`ForbiddenError`/`ConflictError`/`PreconditionFailedError` to
their codes, else `console.error(err)` + generic 500.

**`apps/server/src/cron.ts`** line ~17 and **`apps/server/src/index.ts`** lines
~25 — bare `console.error(...)` with no structure. `createApi.ts` line ~71 — bare
`console.error(err)`.

## Commands you will need

| Purpose  | Command      | Expected |
| -------- | ------------ | -------- |
| Test all | `pnpm test`  | all pass |
| Check    | `pnpm check` | exit 0   |

## Scope

**In scope**:

- `packages/core/src/errors.ts` — add `NotInitializedError` (→ 404 or 409) and
  `UnavailableError` (→ 503).
- `packages/core/src/services/CatalogService.ts` — throw `NotInitializedError`.
- `packages/core/src/services/SandboxProvisioner.ts` — throw `UnavailableError`.
- `packages/api/src/createApi.ts` — map the new errors; add request context to
  the error log.
- A tiny logger module (either `packages/api/src/log.ts` or
  `apps/server/src/log.ts`) emitting one JSON object per event; use it in
  `createApi`'s handler and in `apps/server` (`index.ts`, `cron.ts`).
- Tests in `packages/api` (and `core`) for the new mappings.

**Out of scope** (do NOT touch):

- Adding a heavy logging dependency (pino/winston) — a ~20-line JSON
  `console.log(JSON.stringify({...}))` wrapper is sufficient and keeps the
  Workers build dependency-free.
- Changing the success-response envelope or any 2xx behavior.
- Redacting secrets beyond not logging request bodies/headers (the current
  handler already returns generic client messages; do not log full headers).

## Git workflow

- Branch: `advisor/010-typed-errors-logging`
- Commit message: `Add typed infra errors + structured request logging`.

## Steps

### Step 1: Add error subtypes

In `packages/core/src/errors.ts`:

```ts
/** Storage exists but the catalog/snapshot has not been initialized yet. */
export class NotInitializedError extends Error {
	readonly status = 409;
	constructor(message = 'Not initialized') {
		super(message);
		this.name = 'NotInitializedError';
	}
}

/** An external dependency (compute/storage) is unavailable — transient. */
export class UnavailableError extends Error {
	readonly status = 503;
	constructor(message = 'Service unavailable') {
		super(message);
		this.name = 'UnavailableError';
	}
}
```

Export them from the package barrel (`packages/core/src/index.ts`) alongside the
existing errors.

**Verify**: `pnpm check` exits 0.

### Step 2: Throw typed errors in services

- In `CatalogService`, replace the four generic `Error(...)` throws with
  `NotInitializedError(...)` (keep the messages). Import it from `../errors`.
  Note the existing bottom-of-file `import { ConflictError }` pattern — add the
  new import the same way or consolidate the error imports at the top.
- In `SandboxProvisioner`, replace the "Sandbox container is not available"
  generic `Error` with `UnavailableError`. Import from `../errors`.

**Verify**: `pnpm --filter @marimo-hub/core test` → pass.

### Step 3: Map the new errors in the API handler

In `createApi.ts` `onError`, add branches before the generic 500:

```ts
if (err instanceof NotInitializedError) {
	return c.json({ success: false, error: { code: 'NOT_INITIALIZED', message: err.message } }, 409);
}
if (err instanceof UnavailableError) {
	return c.json(
		{ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: err.message } },
		503,
	);
}
```

Import both from `@marimo-hub/core`. Keep the generic 500 fallback last.

**Verify**: `pnpm check` exits 0.

### Step 4: Add a minimal structured logger and thread request context

Create a tiny logger (no deps):

```ts
// packages/api/src/log.ts
export function logEvent(fields: Record<string, unknown>): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}
```

In `createApi`'s `onError`, replace `console.error(err)` with a structured line
that includes the route, method, and user id when available:

```ts
logEvent({
	level: 'error',
	event: 'request_error',
	method: c.req.method,
	path: c.req.path,
	user: c.get('user')?.id ?? null,
	error: err instanceof Error ? err.message : String(err),
	name: err instanceof Error ? err.name : undefined,
});
```

(Do not log the full error object or stack to the client; the client still gets
the generic envelope. Server-side, message + name + route is enough to triage;
keep stacks out of the JSON to avoid leaking storage paths into log aggregators —
or include a `stack` field only when an env flag like `MARIMOHUB_LOG_STACKS=true`
is set.)

In `apps/server/src/cron.ts` and `index.ts`, replace the bare `console.error`
calls with `logEvent({ level: 'error', event: 'session_maintenance_failed' | 'boot_failed', error: ... })`.
(Import the logger; if importing across the api/server boundary is awkward,
duplicate the ~5-line helper in `apps/server/src/log.ts`.)

**Verify**: `pnpm check && pnpm build` exit 0.

### Step 5: Tests

In `packages/api` route tests, add cases asserting the new mappings, e.g. a
handler/service that throws `NotInitializedError` → response status 409 with code
`NOT_INITIALIZED`; `UnavailableError` → 503 `SERVICE_UNAVAILABLE`. The existing
route test harness builds an `onError` mirror — extend it (or test `createApi`'s
real handler) to cover these. In `core`, assert `CatalogService.getCurrentSnapshot`
on an uninitialized bucket throws `NotInitializedError`.

**Verify**: `pnpm test` → all pass.

## Test plan

- New cases: core throws `NotInitializedError`/`UnavailableError`; API maps them
  to 409/503.
- Pattern: existing `packages/api/src/routes/projects.test.ts` `onError` mirror;
  existing `CatalogService.test.ts`.
- Verification: `pnpm test`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `NotInitializedError` and `UnavailableError` exist and are exported from
      `@marimo-hub/core`.
- [ ] `grep -n "new Error('Catalog not found" packages/core/src/services/CatalogService.ts`
      returns no match (replaced with the typed error).
- [ ] API handler maps both new errors (grep `NOT_INITIALIZED` and
      `SERVICE_UNAVAILABLE` in `createApi.ts`).
- [ ] `createApi`'s error log is a structured JSON line including method/path.
- [ ] `pnpm check && pnpm test && pnpm build` exit 0.
- [ ] No files outside the in-scope list modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- Choosing 409 vs 404 for `NotInitializedError` matters to a client contract you
  can't see — default to 409 (the bucket exists but is not initialized) and note
  the choice; do not invent a new top-level code without flagging it.
- Importing a logger across the api→server package boundary creates a dependency
  cycle — duplicate the tiny helper in `apps/server` instead and report.

## Maintenance notes

- A correlation id (per-request UUID) is the natural next step: set it in a
  middleware, attach to `logEvent`, and return it in error responses so users can
  quote it to support. Deferred here to keep the change small.
- Reviewer should confirm no stack traces or request bodies reach the client and
  that server logs avoid dumping secrets (Modal errors already only carry status
  - response text, not credentials).
