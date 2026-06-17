# Plan 005: Close session & sandbox authorization gaps, and add the missing route tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update this plan's status
> row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- packages/api/src/routes/sessions.ts packages/api/src/routes/sandbox.ts packages/api/src/routes/notebooks.ts packages/api/src/shared.ts`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (adds authorization checks that will return 403/404 where the routes previously returned 200; verify no internal caller relied on the open behavior)
- **Depends on**: 001 (verification baseline) recommended first
- **Category**: security
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

The session routes act on a session by its `sid` **without checking that the
session belongs to the project/notebook in the URL or that the caller is allowed
to touch it**. `DELETE …/sessions/{sid}` terminates _any_ session (and tears
down its sandbox); `POST …/sessions/{sid}/heartbeat` revives/extends _any_
session. The docs (`bucket_spec.md §12`) assume heartbeat/terminate "act on a
session the caller already created (which required editor+)" — but the code
never enforces that assumption. The result is an IDOR: an authenticated user can
disrupt another project's running kernels (DoS), and a `viewer` can terminate
sessions they could never have created. Separately, the **`/api/sandbox/*`
routes** (create/exec/destroy a raw sandbox by id) have no authorization beyond
"is logged in", and `GET …/versions/{vid}` does not validate `vid`'s format
(every other ID param is regex-validated). And the **sessions route has zero
tests**. This plan adds the ownership/role checks, validates `vid`, and adds the
route tests that would catch a regression.

## Current state

**`packages/api/src/routes/sessions.ts`** — handlers use only `sid`:

```ts
// deleteSession (lines ~116-142): no auth check, acts on any sid
app.openapi(deleteSession, async (c) => {
	const { sessions } = c.get('deps').services;
	const { sid } = c.req.valid('param'); // pid/nid in path are IGNORED
	const session = await sessions.terminate(sid as SessionId);
	if (session.sandbox_id) {
		/* teardown sandbox */
	}
	return c.json({ success: true }, 200);
});

// heartbeatSession (lines ~144-164): no auth check, acts on any sid
app.openapi(heartbeatSession, async (c) => {
	const { sessions } = c.get('deps').services;
	const { sid } = c.req.valid('param');
	const updated = await sessions.heartbeat(sid as SessionId);
	return c.json(
		{
			success: true,
			data: {
				/* ... */
			},
		},
		200,
	);
});
```

`createSession` (lines ~66-114) DOES gate correctly:
`await assertProjectRole(projects, pid as ProjectId, user.id, 'editor');`

**Authz helper** — `packages/api/src/shared.ts`:

```ts
export async function assertProjectRole(projects, pid, userId, min) {
	const project = await projects.getProject(pid); // 404 if project missing
	requireRole(project, userId, min); // 403 if role too low
}
```

Path-param schemas in `shared.ts`: `ProjectIdParam` (regex `^proj_…`),
`NotebookIdParam` (adds `^nb_…`), `SessionIdParam` (adds `^sess_…`),
`SandboxIdParam` (`id: z.string()` — unvalidated, format `a1b2c3d4`).

**Session model** — `SessionService.getSession` does **not exist** yet; the
service exposes `createSession`, `setRunning`, `heartbeat`, `terminate`,
`listSessions`, `expireStale`, `reapTerminated`. A `Session` record carries
`session_id`, `notebook_id`, `project_id`, `user_id`, `status`, … (see
`packages/core/src/schema.ts` `SessionSchema`). To authorize, you must be able
to load a session and inspect its `project_id`/`notebook_id`/`user_id`.

**`packages/api/src/routes/sandbox.ts`** — `createSandbox`, `execCommand`,
`destroySandbox` use only `c.get('deps').compute`; no project/role check. These
create and run commands in a bare sandbox by id. (Note: running user code in a
sandbox is by-design; the gap is that _any_ authenticated user can target _any_
sandbox id with `exec`.)

**`packages/api/src/routes/notebooks.ts`** — `getVersion` route declares
`vid: z.string()` (no regex), unlike every other ID param. `NotebookService.getVersion`
casts it straight into a storage path. On the supported object stores keys are
literal (so this is not arbitrary-object traversal), but it is an unvalidated
input inconsistent with the rest of the API.

Test exemplars: `packages/api/src/routes/projects.test.ts` (has the canonical
"403 for a non-member" test using a second `createTestApp(bucket, 'user_stranger')`)
and `packages/api/src/routes/sandbox.test.ts` (fake compute provider with a
sandbox stub). Both use `MemoryBucket` + `ACTOR` from `@marimo-hub/core/testing`.

## Commands you will need

| Purpose   | Command                              | Expected   |
| --------- | ------------------------------------ | ---------- |
| Test api  | `pnpm --filter @marimo-hub/api test`  | tests pass |
| Test core | `pnpm --filter @marimo-hub/core test` | tests pass |
| Test all  | `pnpm test`                          | all pass   |
| Check     | `pnpm check`                         | exit 0     |

## Scope

**In scope**:

- `packages/core/src/services/SessionService.ts` — add a `getSession(id)` read
  method (needed to authorize). Add a unit test for it.
- `packages/api/src/routes/sessions.ts` — authorize `deleteSession` and
  `heartbeatSession`.
- `packages/api/src/routes/sandbox.ts` — gate the sandbox routes (see Step 3 for
  the chosen policy).
- `packages/api/src/routes/notebooks.ts` — validate `vid` with the ULID regex.
- `packages/api/src/routes/sessions.test.ts` (create).
- `packages/core/src/services/SessionService.test.ts` — add `getSession` test.

**Out of scope** (do NOT touch):

- `createSession`'s existing `assertProjectRole(... 'editor')` — already correct.
- The `SessionService.heartbeat` terminal-state behavior — a separate concern
  (see plan 006 maintenance note); do not change it here beyond adding
  `getSession`.
- Read-side tenant isolation on GET routes — that is a documented v1 scope cut
  (see `plans/README.md` direction notes), not part of this plan.

## Git workflow

- Branch: `advisor/005-session-sandbox-authz`
- Commit message: `Authorize session/sandbox mutations; validate version id`.

## Steps

### Step 1: Add `SessionService.getSession`

In `packages/core/src/services/SessionService.ts`, add a read method that loads
and validates a session, throwing `NotFoundError` when absent (mirror the
existing `terminate`/`heartbeat` load pattern, which already does
`SessionSchema.parse`):

```ts
async getSession(id: SessionId): Promise<Session> {
  const obj = await this.bucket.get(paths.session(id));
  if (!obj) throw new NotFoundError(`Session ${id} not found`);
  return SessionSchema.parse(await obj.json());
}
```

Add a unit test in `SessionService.test.ts`: created session is returned by
`getSession`; a random id throws `NotFoundError`.

**Verify**: `pnpm --filter @marimo-hub/core test` → pass.

### Step 2: Authorize `deleteSession` and `heartbeatSession`

In both handlers, load the session, then enforce two checks:

1. **Scoping**: the session's `project_id` and `notebook_id` must match the
   `pid`/`nid` in the path — otherwise `404 NOT_FOUND` (do not leak that the
   session exists under a different notebook). Throw `NotFoundError`.
2. **Authorization**: the caller must be allowed to act. Use
   `assertProjectRole(projects, session.project_id, user.id, 'editor')` — the
   same bar as creating a session. (Owning the session, i.e.
   `session.user_id === user.id`, is _not sufficient on its own_ under the v1
   role model; gating on editor+ on the project is consistent with
   `createSession` and with `bucket_spec.md §12`.)

Target shape for `deleteSession`:

```ts
app.openapi(deleteSession, async (c) => {
	const { sessions, projects } = c.get('deps').services;
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');

	const existing = await sessions.getSession(sid as SessionId);
	if (existing.project_id !== (pid as ProjectId) || existing.notebook_id !== (nid as NotebookId)) {
		throw new NotFoundError(`Session ${sid} not found`);
	}
	await assertProjectRole(projects, pid as ProjectId, user.id, 'editor');

	const session = await sessions.terminate(sid as SessionId);
	if (session.sandbox_id) {
		/* existing teardown block unchanged */
	}
	return c.json({ success: true }, 200);
});
```

Apply the identical scoping + `assertProjectRole(... 'editor')` to
`heartbeatSession` before it calls `sessions.heartbeat(sid)`. Import
`NotFoundError`, `assertProjectRole`, and the id types as needed (the route
already imports `assertProjectRole` and types from `../shared` /
`@marimo-hub/core`).

Add the corresponding response codes to the route definitions: add
`403: jsonContent(ErrorResponseSchema, 'Insufficient role')` to `deleteSession`
and `heartbeatSession` (the OpenAPI `responses` maps), matching `createSession`.

**Verify**: `pnpm check` exits 0.

### Step 3: Gate the `/api/sandbox/*` routes

The raw sandbox routes (`POST /sandbox`, `POST /sandbox/{id}/exec`,
`DELETE /sandbox/{id}`) currently run for any authenticated user. There are two
defensible policies — pick **(A)** unless the operator says otherwise, and note
the choice in the PR description:

- **(A) Remove the raw sandbox routes from the mounted API.** They are not used
  by the SPA (which provisions kernels via the session routes) and they expose
  arbitrary command execution by sandbox id. In `packages/api/src/createApi.ts`,
  stop mounting `sandboxApp` (delete the `app.route('/api', sandboxApp)` line and
  the import), and delete `packages/api/src/routes/sandbox.ts` +
  `sandbox.test.ts`. This is the smallest attack surface.
- **(B) Keep them but require a deployment opt-in.** Only mount `sandboxApp` when
  a flag (e.g. `deps.enableRawSandboxRoutes`) is set, defaulting off.

If you are unsure whether anything depends on these routes, choose (B) so
behavior is preserved behind a default-off flag, and flag the decision for
review. **Before choosing (A), grep the repo** for usages:
`grep -rn "/api/sandbox" packages examples apps` and
`grep -rn "sandboxApp\|routes/sandbox" packages` — if the SPA or an example
calls them, do NOT remove; use (B).

**Verify**: `pnpm check` exits 0; if you chose (A), `grep -rn "sandboxApp" packages/api/src` returns no matches.

### Step 4: Validate the `vid` path param

In `packages/api/src/routes/notebooks.ts`, the `getVersion` route inlines
`vid: z.string()`. Replace it with the ULID-format regex used elsewhere
(`^ver_[0-9A-Z]{26}$`), matching the example already present:

```ts
params: NotebookIdParam.extend({
  vid: z.string().regex(/^ver_[0-9A-Z]{26}$/).openapi({
    param: { name: 'vid', in: 'path' },
    example: 'ver_01HXYZ33333RSTUVWXYZAB',
  }),
}),
```

(Optionally, export a `VersionIdParam`/reuse a shared `vid` schema in
`shared.ts` for consistency — not required.)

**Verify**: `pnpm check` exits 0.

### Step 5: Add `packages/api/src/routes/sessions.test.ts`

Model it on `projects.test.ts` (the "403 for a non-member" test) and
`sandbox.test.ts` (fake compute). Build a test app with a fake
`SandboxProvider` whose `create()` returns a stub covering the methods the
session path uses (`exec`, `startProcess`→`waitForPort`, `exposePort`,
`destroy`, `readFile`, `writeFile`, `mountBucket`). Seed a project (owner =
`ACTOR`) and a notebook via the services or fixtures, then test:

- `POST …/sessions` as `ACTOR` (editor/owner) → 200, returns a session whose
  `status` is `running`.
- `POST …/sessions` as `user_stranger` (non-member) → 403.
- `DELETE …/sessions/{sid}` for a session owned under the project, as a
  **non-member** stranger → 403 (the IDOR fix).
- `DELETE …/sessions/{sid}` where `{sid}` belongs to a _different_
  notebook/project than the URL path → 404 (the scoping fix).
- `POST …/sessions/{sid}/heartbeat` as a non-member → 403.
- `DELETE`/`heartbeat` happy path as the owner → 200.

If wiring a full provisioner stub is heavy, factor the fake compute like
`sandbox.test.ts`'s `fakeSandboxInstance` and have `provision` succeed with a
fixed URL.

**Verify**: `pnpm --filter @marimo-hub/api test` → all pass, including
`sessions.test.ts`.

## Test plan

- New: `packages/api/src/routes/sessions.test.ts` (cases in Step 5) and a
  `getSession` case in `SessionService.test.ts`.
- Updated (if you chose policy A): remove `sandbox.test.ts`. If policy B: add a
  test that the sandbox routes are absent unless the flag is set.
- Pattern: `projects.test.ts` for the 403 structure; `sandbox.test.ts` for fake
  compute.
- Verification: `pnpm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `deleteSession` and `heartbeatSession` call `assertProjectRole(... 'editor')`
      and scope-check `project_id`/`notebook_id` (grep:
      `grep -n "assertProjectRole" packages/api/src/routes/sessions.ts` shows ≥3 matches).
- [ ] `SessionService.getSession` exists and is tested.
- [ ] `getVersion`'s `vid` param has a `^ver_…` regex (grep:
      `grep -n "ver_\[0-9A-Z\]" packages/api/src/routes/notebooks.ts` matches).
- [ ] Sandbox routes are removed (policy A) or default-off (policy B), with the
      choice noted in the PR description.
- [ ] `sessions.test.ts` exists; the non-member 403 and cross-notebook 404 cases
      pass.
- [ ] `pnpm check && pnpm test` exit 0.
- [ ] No files outside the in-scope list modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The SPA (`packages/web`) or an example imports the `/api/sandbox` routes — do
  NOT remove them; use policy B and report.
- Authorizing `heartbeat` with `assertProjectRole` would break the kernel
  heartbeat client (e.g. heartbeats are sent with a token that is not the
  project member's identity) — report how the kernel authenticates its
  heartbeats before changing the policy; the heartbeat may legitimately need a
  session-scoped credential rather than a project role.
- `assertProjectRole` cannot be imported into `sessions.ts` for a layering
  reason — it already is imported there (`createSession` uses it), so this should
  not occur; if it does, report.

## Maintenance notes

- If the kernel↔hub heartbeat is later given its own session token, revisit the
  heartbeat authorization (a session-scoped token check may replace the project
  role check).
- A reviewer should confirm the 404-vs-403 distinction does not leak existence:
  cross-scope sessions return 404, insufficient role returns 403 only after the
  scope check passes.
- The sandbox-route decision (A vs B) should be revisited if a public sandbox
  API becomes a product goal — at which point it needs its own auth model, not
  just the project role check.
