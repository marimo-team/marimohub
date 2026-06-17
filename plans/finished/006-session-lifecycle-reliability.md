# Plan 006: Make session/sandbox lifecycle reliable — clean up on provision failure, don't revive terminal sessions, and test the provisioner

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update this plan's status
> row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- packages/api/src/routes/sessions.ts packages/core/src/services/SessionService.ts packages/core/src/services/SandboxProvisioner.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (touches the kernel provisioning path; a bug here blocks users from starting notebooks)
- **Depends on**: 005 (session route authz) recommended first — both edit `sessions.ts`; do 005, then this
- **Category**: bug / tests
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

Two session-lifecycle defects and a coverage gap:

1. **Orphaned session + leaked sandbox on provision failure.** `createSession`
   writes the session record, then provisions a sandbox _outside any try/catch_.
   If `provision()` throws (Docker down, Modal timeout, port never opens), the
   error propagates as a 500, the session is left stuck in `starting`, and the
   partially-created sandbox is never destroyed — a resource leak that recurs on
   every failed attempt.
2. **Heartbeat resurrects terminal sessions.** `SessionService.heartbeat`
   unconditionally sets `status: 'running'`. A late heartbeat on a `terminated`
   or `expired` session flips it back to `running`, defeating the reaper and
   keeping a dead session "alive".
3. **`SandboxProvisioner` has zero tests**, despite being the orchestration core
   of the feature MarimoHub exists for (mount-or-copy fallback, start marimo,
   wait for port, expose URL, teardown).

## Current state

**`packages/api/src/routes/sessions.ts`**, `createSession` (lines ~66–114) — no
try/catch around provisioning:

```ts
const session = await sessions.createSession({
	/* status: 'starting' */
});
const provisioner = new SandboxProvisioner(compute);
const { url, usedFallback } = await provisioner.provision({ sandboxId /* ... */ }); // can throw
const updated = await sessions.setRunning(session.session_id, url, usedFallback);
return c.json(
	{
		success: true,
		data: {
			/* ... */
		},
	},
	200,
);
```

**`packages/core/src/services/SessionService.ts`**, `heartbeat` (lines ~66–90):

```ts
const session = SessionSchema.parse(await obj.json());
const ageMs = Date.now() - new Date(session.last_heartbeat).getTime();
if (session.status === 'running' && ageMs < HEARTBEAT_PERSIST_INTERVAL_MS) {
	return session; // coalesced no-op
}
const updated: Session = {
	...session,
	status: 'running',
	last_heartbeat: new Date().toISOString(),
};
await this.bucket.put(paths.session(id), JSON.stringify(updated)); // <-- revives terminal sessions
```

Valid statuses (`schema.ts`): `starting | running | idle | terminated | expired`.

**`packages/core/src/services/SandboxProvisioner.ts`** — `provision(options)`:
`create` sandbox → `exec('true')` reachability check (throws a friendly error if
unreachable) → `mountBucket` (on throw: `usedFallback = true` and
`loadNotebookFiles` if `bucketHandle` present) → `startProcess('uv run marimo
edit …')` → `process.waitForPort(2718)` → `exposePort(2718, { hostname, token:
sandboxId })` → returns `{ sandbox, url, usedFallback }`. `teardown(sandbox,
bucket, projectId, notebookId, usedFallback)` → `saveNotebookFiles` if fallback,
then `sandbox.destroy()`. No tests exist for this file.

The `SandboxProvider`/`SandboxInstance` port lives in
`packages/core/src/ports/sandbox.ts`; tests can supply a hand-rolled fake
implementing only the methods exercised (see `packages/api/src/routes/sandbox.test.ts`
`fakeSandboxInstance` for the style).

## Commands you will need

| Purpose   | Command                              | Expected   |
| --------- | ------------------------------------ | ---------- |
| Test core | `pnpm --filter @marimo-hub/core test` | tests pass |
| Test api  | `pnpm --filter @marimo-hub/api test`  | tests pass |
| Test all  | `pnpm test`                          | all pass   |
| Check     | `pnpm check`                         | exit 0     |

## Scope

**In scope**:

- `packages/api/src/routes/sessions.ts` — wrap provisioning with cleanup.
- `packages/core/src/services/SessionService.ts` — `heartbeat` terminal-state
  guard.
- `packages/core/src/services/SessionService.test.ts` — heartbeat-guard tests.
- `packages/core/src/services/SandboxProvisioner.test.ts` (create).

**Out of scope** (do NOT touch):

- `SandboxProvisioner`'s provisioning logic itself — this plan tests it and
  cleans up _callers_; do not change the marimo command, ports, or fallback
  logic.
- The compute adapters (`compute-modal`, `compute-cloudflare`).
- `expireStale`/`reapTerminated` — unchanged (they already handle `starting`).

## Git workflow

- Branch: `advisor/006-session-lifecycle`
- Commit message: `Clean up session/sandbox on provision failure; stop heartbeat reviving terminal sessions; test provisioner`.

## Steps

### Step 1: Clean up on provisioning failure in `createSession`

Wrap the provision→setRunning block in try/catch. On failure: best-effort tear
down the sandbox, mark the session `terminated` (so the reaper collects it), and
re-throw so the client still gets an error.

Target shape:

```ts
const session = await sessions.createSession({
	/* unchanged */
});
const { compute, bucket: bucketHandle, sandboxBucket, sandboxHostname } = c.get('deps');
const provisioner = new SandboxProvisioner(compute);
const hostname = sandboxHostname || new URL(c.req.url).hostname;

let url: string, usedFallback: boolean;
try {
	({ url, usedFallback } = await provisioner.provision({
		sandboxId,
		projectId: pid as ProjectId,
		notebookId: nid as NotebookId,
		hostname,
		bucket: sandboxBucket,
		bucketHandle,
	}));
} catch (err) {
	// Provisioning failed: tear down any partial sandbox and mark the session
	// terminated so it does not linger in `starting` and so the reaper collects it.
	try {
		await compute.create(sandboxId).destroy();
	} catch {
		/* sandbox may not exist */
	}
	try {
		await sessions.terminate(session.session_id);
	} catch {
		/* best-effort */
	}
	throw err;
}

const updated = await sessions.setRunning(session.session_id, url, usedFallback);
return c.json(
	{
		success: true,
		data: {
			/* unchanged */
		},
	},
	200,
);
```

(Keep the response payload exactly as before.)

**Verify**: `pnpm check` exits 0.

### Step 2: Guard `heartbeat` against reviving terminal sessions

In `SessionService.heartbeat`, after loading and parsing the session, return
early (without writing) when the session is already terminal, so a stray
heartbeat cannot resurrect it:

```ts
const session = SessionSchema.parse(await obj.json());

// A terminal session must not be revived by a late heartbeat.
if (session.status === 'terminated' || session.status === 'expired') {
	return session;
}

const ageMs = Date.now() - new Date(session.last_heartbeat).getTime();
if (session.status === 'running' && ageMs < HEARTBEAT_PERSIST_INTERVAL_MS) {
	return session;
}
// ... existing write of { status: 'running', last_heartbeat: now }
```

Decide the API surface: returning the unchanged terminal session keeps the
method total. (The route from plan 005 already 403/404-gates who may call
heartbeat; this guard is the service-level safety net. If product wants a hard
error instead, throwing `ConflictError` is acceptable — but default to the
no-op-return to avoid a breaking change, and note the choice.)

**Verify**: `pnpm --filter @marimo-hub/core test` → pass.

### Step 3: Add heartbeat-guard tests to `SessionService.test.ts`

Add cases (match the file's existing style):

- Heartbeat on a `terminated` session leaves status `terminated` (does not flip
  to `running`); assert the stored record is unchanged.
- Heartbeat on an `expired` session leaves status `expired`.
- Heartbeat on a `starting` session promotes it to `running` and updates
  `last_heartbeat` (regression guard that the first real heartbeat still works).

**Verify**: `pnpm --filter @marimo-hub/core test` → pass.

### Step 4: Add `SandboxProvisioner.test.ts`

Create `packages/core/src/services/SandboxProvisioner.test.ts` with a fake
`SandboxProvider`/`SandboxInstance`. Cover:

1. **Happy path with mount**: `mountBucket` succeeds → `usedFallback === false`;
   assert the returned `url` is the one `exposePort` produced; assert
   `startProcess` was called with a command containing `marimo edit` and port
   `2718`.
2. **Fallback path**: `mountBucket` throws → `usedFallback === true` and
   `loadNotebookFiles` path runs (provide a `bucketHandle` `MemoryBucket` seeded
   with `notebook.py`/`pyproject.toml`; assert `writeFile` was called for the
   mount path).
3. **Unreachable sandbox**: `exec('true')` throws → `provision` rejects with the
   "Sandbox container is not available" message.
4. **Teardown**: with `usedFallback === true`, `teardown` calls
   `saveNotebookFiles` (reads sandbox files, writes back to bucket) then
   `destroy`; with `usedFallback === false`, it only `destroy`s.

Use a spy/counter object for the fake instance methods (plain closures that
record calls — no mocking library needed; see `sandbox.test.ts`).

**Verify**: `pnpm --filter @marimo-hub/core test` → all pass including the new
file.

## Test plan

- New: `SandboxProvisioner.test.ts` (4 cases above).
- Updated: `SessionService.test.ts` (3 heartbeat-guard cases).
- API behavior (Step 1) is best covered by an added case in `sessions.test.ts`
  (from plan 005): a fake provisioner whose `provision` rejects → response is an
  error AND the session ends up `terminated` (assert via the bucket/service).
  Add this case if plan 005's test file exists; otherwise note it as deferred.
- Verification: `pnpm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `createSession` wraps `provision` in try/catch with sandbox teardown +
      `terminate` on failure (grep: `grep -n "catch" packages/api/src/routes/sessions.ts` shows the provision catch).
- [ ] `heartbeat` returns early for `terminated`/`expired` without writing
      (grep: `grep -n "terminated' || session.status === 'expired'" packages/core/src/services/SessionService.ts` matches).
- [ ] `SandboxProvisioner.test.ts` exists and its 4 cases pass.
- [ ] Heartbeat-guard tests pass.
- [ ] `pnpm check && pnpm test` exit 0.
- [ ] No files outside the in-scope list modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- `compute.create(sandboxId)` for teardown on failure has side effects that
  could _create_ a sandbox (rather than reference one) — inspect the adapter; if
  `create` is not idempotent/reference-only, skip the destroy and report (the
  Modal/Cloudflare `create` are reference-only constructors, so this should be
  safe).
- Making `heartbeat` a no-op on terminal status breaks an existing test that
  asserted the old reviving behavior — that test encoded the bug; update it and
  note the change.

## Maintenance notes

- If sessions later move liveness off the bucket (`bucket_spec.md §8` "first
  lever"), the heartbeat-guard and the reaper both change together — keep them
  consistent.
- A reviewer should confirm the failure path in `createSession` does not swallow
  the original error (it must re-throw so the client sees a 5xx and the cause is
  logged).
- Consider emitting a `session.terminate`/failure event on the cleanup path so
  provisioning failures are auditable (depends on plan 010's logging work).
