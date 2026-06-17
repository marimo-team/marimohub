# Plan 003: Fail closed on auth-backend selection, and add auth-adapter tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update this plan's status
> row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- packages/config/src/index.ts packages/auth-dev packages/auth-oidc packages/auth-cloudflare-access`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (changes the default behavior of `createFromEnv`; a deployment relying on the implicit `dev` default will now fail to boot — that is the intended correction, but it is a behavior change)
- **Depends on**: 001 (verification baseline) recommended first
- **Category**: security
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

`createFromEnv` silently defaults the **authentication backend to the
dev-bypass** when `MARIMOHUB_AUTH_BACKEND` is unset. The dev bypass
(`DevAuthenticator`) authenticates _every_ request as a fixed user with no
identity check. So a production deployment that forgets to set one env var does
not fail — it comes up wide open, authenticating every anonymous request as a
single admin-capable user. A footgun this sharp should fail closed: an unset or
unknown auth backend must refuse to boot. Separately, all three auth adapters
(OIDC, Cloudflare Access, dev) have **zero tests**, even though JWT/cookie
verification is the system's primary security boundary. This plan closes the
fail-open default and adds the missing verification tests.

## Current state

**`packages/config/src/index.ts`** — the composition root. The storage and
compute selectors already fail closed (unknown backend throws), but auth
defaults to `dev`:

```ts
// lines 39-41 (storage — already fails closed on unknown):
function makeStorage(env: Env): Bucket {
  const backend = env.MARIMOHUB_STORAGE_BACKEND ?? 's3';
  switch (backend) { /* ... default: throw new Error(`Unknown ...`) */ }

// lines 94-122 (auth — defaults to 'dev'):
function makeAuth(env: Env): { authenticator: Authenticator; authRoutes?: Hono } {
  const backend = env.MARIMOHUB_AUTH_BACKEND ?? 'dev';   // <-- fail-OPEN default
  switch (backend) {
    case 'oidc': { /* ... requires OIDC_* env, returns oidc authenticator */ }
    case 'dev':
      return { authenticator: new DevAuthenticator({
        userId: env.MARIMOHUB_AUTH_DEV_USER_ID,
        email: env.MARIMOHUB_AUTH_DEV_EMAIL,
      }) };
    case 'cloudflare-access':
      throw new Error('MARIMOHUB_AUTH_BACKEND=cloudflare-access is wired in examples/cloudflare-worker.');
    default:
      throw new Error(`Unknown MARIMOHUB_AUTH_BACKEND: ${backend}`);
  }
}
```

**`packages/auth-dev/src/index.ts`** — `DevAuthenticator.authenticate()` returns
a fixed `{ id, email }` for every request and logs a `console.warn` on
construction. Defaults: `id: 'user'`, `email: 'user@localhost'`.

**`packages/auth-oidc/src/index.ts`** — `createOidcAuth(config)` returns
`{ authenticator, routes }`. `authenticator.authenticate(request)` reads the
`mh_session` cookie and verifies it with `jwtVerify(token, secret)` (HS256
shared secret). On success returns `{ id: payload.sub, email: payload.email }`
only if both `sub` and a string `email` are present; otherwise `null`; any throw
→ `null`. Session cookies are minted by `signSession()` using `SignJWT` HS256
with `sessionSecret`.

**`packages/auth-cloudflare-access/src/index.ts`** —
`CloudflareAccessAuthenticator.authenticate(request)` reads the
`CF-Access-JWT-Assertion` header, verifies it against the team JWKS with
`jwtVerify(jwt, this.jwks, { audience })`, and returns `{ id: sub, email }` or
`null` (missing header / missing claims / verify throw).

There are **no `*.test.ts` files** in `auth-dev`, `auth-oidc`, or
`auth-cloudflare-access`, and none in `config`.

Test conventions (exemplar to copy): `packages/api/src/routes/projects.test.ts`
uses vitest (`describe/it/expect/beforeEach`) and `@marimo-hub/core/testing`.
`auth-oidc` and `auth-cloudflare-access` declare `vitest` as a devDep in
`packages/core/package.json` style — **check each package's `package.json`**:
`auth-dev`, `auth-oidc`, `auth-cloudflare-access`, and `config` currently do NOT
list `vitest`/`@types/node` as devDeps or a `test` script. You will add them
(Step 4).

## Commands you will need

| Purpose          | Command                                   | Expected   |
| ---------------- | ----------------------------------------- | ---------- |
| Install          | `pnpm install`                            | exit 0     |
| Test one package | `pnpm --filter @marimo-hub/auth-oidc test` | tests pass |
| Test all         | `pnpm test`                               | all pass   |
| Check            | `pnpm check`                              | exit 0     |

## Scope

**In scope**:

- `packages/config/src/index.ts` — change the auth default (Step 1).
- `packages/config/src/index.test.ts` (create) — test the fail-closed behavior.
- `packages/auth-oidc/src/index.test.ts` (create).
- `packages/auth-cloudflare-access/src/index.test.ts` (create).
- `packages/auth-dev/src/index.test.ts` (create).
- The `package.json` of `config`, `auth-oidc`, `auth-cloudflare-access`,
  `auth-dev` — add a `test` script + `vitest`/`@types/node` devDeps **only where
  missing** (Step 4).

**Out of scope** (do NOT touch):

- The OIDC login/callback/logout _route_ logic in `auth-oidc` (the PKCE flow) —
  test the `authenticate()` path and `signSession`/cookie verification only;
  end-to-end OAuth flow testing is deferred.
- `DevAuthenticator`'s behavior — it is _correct_ as a local bypass; do not
  change it. The fix is in `config`, not in `auth-dev`.
- The storage/compute selectors in `config` — already fail closed.

## Git workflow

- Branch: `advisor/003-auth-fail-closed`
- Commit message: `Fail closed on unset auth backend; add auth-adapter tests`.

## Steps

### Step 1: Make `makeAuth` fail closed on an unset/empty backend

In `packages/config/src/index.ts`, change the auth backend resolution so an
unset or empty `MARIMOHUB_AUTH_BACKEND` throws instead of defaulting to `dev`.
The `dev` backend must remain available, but **only when explicitly requested**.

Target shape (replace the `const backend = env.MARIMOHUB_AUTH_BACKEND ?? 'dev';`
line and keep the rest of the switch intact):

```ts
const backend = env.MARIMOHUB_AUTH_BACKEND;
if (!backend) {
	throw new Error(
		'MARIMOHUB_AUTH_BACKEND must be set explicitly (oidc | cloudflare-access | dev). ' +
			'Refusing to start: an unset auth backend previously defaulted to the insecure dev bypass.',
	);
}
switch (
	backend
	/* existing cases unchanged: 'oidc', 'dev', 'cloudflare-access', default */
) {
}
```

Leave the `case 'dev':` body exactly as-is (explicit dev is still allowed).

**Verify**: `pnpm check` exits 0.

### Step 2: Add `packages/config/src/index.test.ts`

Test that `createFromEnv` (or `makeAuth` if you export it — prefer testing
`createFromEnv` with a minimal env) fails closed. `createFromEnv(env)` takes an
env object, so you can pass a fake env without touching `process.env`.

Cover:

- **Unset auth backend throws**: `createFromEnv({ MARIMOHUB_STORAGE_BACKEND: 'memory', MARIMOHUB_COMPUTE_BACKEND: 'none' })` throws with a message mentioning `MARIMOHUB_AUTH_BACKEND`.
- **Explicit `dev` works**: same env plus `MARIMOHUB_AUTH_BACKEND: 'dev'` returns deps with an authenticator that authenticates a fixed user.
- **Unknown backend throws**: `MARIMOHUB_AUTH_BACKEND: 'bogus'` throws `Unknown MARIMOHUB_AUTH_BACKEND`.
- **Missing required storage var throws**: `MARIMOHUB_STORAGE_BACKEND: 's3'` without `MARIMOHUB_STORAGE_S3_BUCKET` throws `Missing required env var`.

Note: `MARIMOHUB_COMPUTE_BACKEND: 'none'` yields a no-op compute provider (see
`makeCompute`), so it is safe in tests. Use `memory` storage to avoid S3 config.

**Verify**: `pnpm --filter @marimo-hub/config test` → all pass.

### Step 3: Add auth-adapter tests

**`packages/auth-oidc/src/index.test.ts`** — exercise the cookie-session
verification round-trip without a network. Because `signSession` is internal,
mint a session token the same way the adapter does, using `jose`'s `SignJWT`
HS256 with a known secret, then assert `authenticate()`:

- Valid `mh_session` cookie (signed with the same `sessionSecret`, containing
  `sub` + string `email`, unexpired) → returns `{ id, email }`.
- Tampered/wrong-secret cookie → returns `null`.
- Expired cookie (`setExpirationTime` in the past) → returns `null`.
- Cookie present but missing `email` claim → returns `null`.
- No cookie header → returns `null`.

Build the authenticator with `createOidcAuth({ issuer, clientId, clientSecret, redirectUri, sessionSecret: 'test-secret-至少-32-bytes-长', ... })`.
You only call `authenticator.authenticate(new Request('http://x', { headers: { cookie: 'mh_session=' + token } }))`; the issuer/JWKS network is never hit by the cookie path.

**`packages/auth-cloudflare-access/src/index.test.ts`** — JWKS verification needs
a key. Either (a) mock `jose`'s `createRemoteJWKSet`/`jwtVerify` via
`vi.mock('jose', ...)`, asserting that a missing `CF-Access-JWT-Assertion`
header returns `null` and a verified payload missing `sub`/`email` returns
`null`; or (b) if mocking `jose` is awkward, at minimum assert the
no-header → `null` path and that a verify-throw → `null` path (mock
`jwtVerify` to reject). Document which approach you used in a comment.

**`packages/auth-dev/src/index.test.ts`** — trivial but worth locking in:
`new DevAuthenticator({ userId: 'u', email: 'e@x' }).authenticate()` resolves to
`{ id: 'u', email: 'e@x' }`; defaults to `{ id: 'user', email: 'user@localhost' }`.

**Verify**: `pnpm --filter @marimo-hub/auth-oidc test && pnpm --filter @marimo-hub/auth-cloudflare-access test && pnpm --filter @marimo-hub/auth-dev test` → all pass.

### Step 4: Wire up `test` scripts and devDeps where missing

For each of `config`, `auth-oidc`, `auth-cloudflare-access`, `auth-dev` whose
`package.json` lacks them, add (mirroring `packages/core/package.json`):

```json
"scripts": { "...": "...", "test": "vp test" },
"devDependencies": { "vitest": "catalog:", "@types/node": "catalog:", "typescript": "catalog:", "vite-plus": "catalog:" }
```

Only add what is missing; do not duplicate existing entries. Then run
`pnpm install` so the workspace links the new devDeps.

**Verify**: `pnpm install` exits 0; `pnpm test` discovers and runs the new test
files (the count of passing test files increases by 4).

## Test plan

- New files: `config/src/index.test.ts`, `auth-oidc/src/index.test.ts`,
  `auth-cloudflare-access/src/index.test.ts`, `auth-dev/src/index.test.ts`.
- Structural pattern: model vitest usage on
  `packages/api/src/routes/projects.test.ts` (imports, `describe/it/expect`).
- Cases enumerated in Steps 2–3 (happy path + the specific fail-closed and
  reject paths).
- Verification: `pnpm test` → all pass, including the 4 new files.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `createFromEnv` with no `MARIMOHUB_AUTH_BACKEND` throws (covered by a
      passing test in `config/src/index.test.ts`).
- [ ] Explicit `MARIMOHUB_AUTH_BACKEND=dev` still works (passing test).
- [ ] `grep -n "?? 'dev'" packages/config/src/index.ts` returns no match.
- [ ] New test files exist for `auth-oidc`, `auth-cloudflare-access`,
      `auth-dev`, `config` and pass.
- [ ] `pnpm check && pnpm test` exit 0.
- [ ] No files outside the in-scope list modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- Mocking `jose` for the Cloudflare Access test proves infeasible in this
  toolchain after a reasonable attempt — ship the no-header + verify-throw cases
  and note the gap; do NOT weaken the adapter to make it testable.
- Adding a `test` script to a package breaks `vp run -r test` (e.g. a package
  that should not have tests) — report which package and the error.
- You find another implicit fail-open default elsewhere in `config` while here
  (there should not be — storage/compute already throw) — report it rather than
  fixing out of scope.

## Maintenance notes

- This makes `MARIMOHUB_AUTH_BACKEND` mandatory. Update
  `apps/server/.env.example` already lists it (`MARIMOHUB_AUTH_BACKEND=oidc`), so
  no doc change is required there, but mention the new hard requirement in the
  PR description and in `README.md` (plan 001) local-dev instructions
  (`MARIMOHUB_AUTH_BACKEND=dev` must be set explicitly for local runs).
- A reviewer should confirm the dev bypass is now reachable _only_ via an
  explicit `dev` value and that the `console.warn` in `DevAuthenticator` remains.
- Follow-up (not in this plan): consider also requiring a separate
  `MARIMOHUB_ALLOW_DEV_AUTH=true` acknowledgement before `dev` is accepted, for
  defense-in-depth.
