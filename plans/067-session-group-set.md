# Plan 067: Bounded IdP group set on the authenticated subject

> From marimo-team/marimohub#456 (2026-10): a large org asks how to structure
> hundreds of projects (org → department → team → repo) with inherited
> membership and IaC provisioning. The maintainer's direction, split across
> plans 066–071, adds **no nested project entity**. The org hierarchy stays in
> the customer's IdP, or in their login-policy module, which flattens
> departments into team groups. marimohub only sees flat, opaque group ids.
> 066 adds tag paths as namespaces. 068 adds groups as project-member
> principals. 069 adds config-driven access rules that bind groups to roles on
> tag prefixes or project ids. 070 covers provisioning ergonomics and 071 list
> scale. **068 and 069 both need the caller's groups at request time. This plan
> supplies them:** a small, bounded, normalized set of IdP group ids on
> `AuthUser`, carried in the signed session for OIDC.

## Status

- **Priority**: P1 (prerequisite of 068 and 069)
- **Effort**: M
- **Risk**: MED (changes the auth port, the session-cookie wire format, and
  the login-policy contract; a wrong bound causes logins to fail or cookies to
  grow too large)
- **Depends on**: — (builds on finished 049 and the login-policy library)
- **Blocks**: 068, 069
- **Category**: auth / access-control
- **Planned at**: 2026-10-07

## Current state

All anchors were verified against the tree on 2026-10-07 (branch
`ms/pre-release-review-v0.4.17`).

**Port and subject**

- `packages/core/src/ports/auth.ts`:
  - `AUTH_ENTITLEMENTS` is at lines 13-20.
  - `AuthUser` is at lines 24-40, with fields `id, email, name?, pictureUrl?,
    entitlements?, entitlementsExpiresAt?`. Line 38 documents
    `entitlementsExpiresAt` as "Expiry of the credential that supplied group
    authorization".
  - `CREDENTIAL_KINDS` is at lines 42-48, `AuthCredential` at 63-77, and
    `AuthenticatedPrincipal extends AuthUser` at 85-87.
  - The file has no zod import.
- `packages/core/src/identityMatch.ts:12-16` defines
  `IdentitySubject { id; email; entitlements? }`.
  `packages/core/src/authz.ts:56` defines `AuthSubject = IdentitySubject`, and
  `packages/core/src/services/authorization/AuthorizationService.ts:75`
  defines `AuthorizationSubject = AuthSubject | AuthenticatedPrincipal`.
- `packages/core/src/securityLabels.ts:14`:
  `SECURITY_LABEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/`. This token
  is **not suitable for group ids**:
  - Okta and Google group names contain spaces or `@`.
  - Keycloak full-path groups start with `/` (`/eng/data-platform`).
  - 64 characters truncates deep Keycloak paths.
- `packages/core/src/ports/subjectContext.ts:1-27` (header): runtime subject
  attributes "NEVER [come] from the raw JWT, UserInfo response, or a
  login-time policy result … the signed session cookie is not encrypted, so
  raw attributes must not ride in it." See Design §"Why session-carried groups
  are acceptable now" for how this plan fits with that rule.

**OIDC adapter (`packages/auth-oidc/src`)**

- `claims.ts`:
  - `OidcGroupPolicy` (lines 7-20) has `claim`, `allowed?`, `superAdmin?`,
    `projectCreation?`, `defaultRoles?`, `maxGroups?`.
  - `MAX_GROUPS = 200` (line 27) and `MAX_GROUP_LENGTH = 256` (line 28).
  - `validGroup` is at lines 111-118 and `validateGroupPolicy` at 120-133.
    `validateGroupPolicy` throws if no list is configured.
  - `parseGroups` (lines 135-146) throws on non-array input, on more than
    `maxGroups` entries, or on a bad entry.
  - `mappedEntitlements` is at lines 148-166.
- `admission.ts`:
  - `OidcAdmissionConfig` is at lines 20-26, `OidcAdmissionPolicy` at 28-33,
    and `createAdmissionPolicy` at 35-56.
  - `AdmissionFailure` (lines 58-63) is `auth_failed | email_not_verified |
    domain_not_allowed | invalid_groups | group_not_allowed`.
  - `admitOidcIdentity` is at lines 66-118. Its group block (lines 90-106)
    reads the claim through the JSON pointer: UserInfo first, then the ID
    token. It parses the claim, enforces `allowed`, and maps entitlements.
    **The parsed group list is then discarded.**
- `accessTokenClaims.ts:52-87`: `principalFromVerifiedAccessToken` (external
  access tokens) **also calls `admitOidcIdentity`** (line 71) and spreads
  `admission.user` into an `external-access-token` principal. When group
  policy is on, it sets `entitlementsExpiresAt` from the token expiry
  (line 79). Any field this plan adds to `admission.user` therefore reaches
  external access tokens automatically.
- `index.ts`:
  - `MAX_SESSION_JWT_BYTES = 3800` is at line 99.
  - `derivedAuthorization = Boolean(config.groups || config.loginPolicy)` is
    at line 184.
  - The TTL bounds are at lines 188-195: a derived session must be ≤ 3600 s.
  - Groups and login policy are mutually exclusive (lines 196-198).
  - `mintSession` is at lines 239-259 and writes the claims `email, name?,
    picture_url?, entitlements?`.
  - `signSession` is at lines 261-278. If the token is too large it drops
    `picture_url`, then `name`, then throws.
  - `authenticate` is at lines 280-331. It re-filters `entitlements` against
    `AUTH_ENTITLEMENT_SET`. It sets `entitlementsExpiresAt` from `exp` when
    the `entitlements` claim is an array.
  - Callback admission is at lines 508-515. `invalid_groups` logs
    `oidc_group_claim_invalid` and redirects with `auth_failed`.
  - The login-policy branch is at lines 517-545, and session signing at
    547-558. Under derived authorization, `entitlements` is always written,
    even when empty.
  - **No successful-login event is logged anywhere.** Only failure events
    exist.
- `loginPolicy.ts`:
  - `OIDC_LOGIN_POLICY_API_VERSION = 1` is at line 22.
  - The `OidcLoginPolicyDecision` type is at lines 42-51.
  - `LoginPolicyResultProblem` is at lines 80-87 and
    `ParsedLoginPolicyDecision` at 89-91.
  - `OidcLoginPolicyDecisionSchema` (lines 108-117) uses `strictObject`s: an
    allow decision accepts only `decision` and `entitlements`.
  - `problemFromIssues` is at lines 119-139, `parseDecision` at 158-179, and
    the `LoginPolicyEvaluation` type at 224-230.
  - `evaluateLoginPolicy` is at lines 245-292, with the allow result at
    285-286.
- `packages/config/src/library.ts:132-136` checks a module's `apiVersion`
  for **exact equality** with `OIDC_LOGIN_POLICY_API_VERSION` (line 58). A
  version bump would therefore reject every existing v1 module at startup.

**Config (`packages/config/src`)**

- `auth.ts`:
  - `checkedGroups` (lines 253-268) accepts ≤ 200 ids of ≤ 256 characters.
  - `GROUP_POLICY_VARS` (lines 270-280) lists the variables that are
    mutually exclusive with the login policy, enforced in `parseLoginPolicy`
    (lines 288-344, conflict check at 317-328).
  - `parseGroupPolicy` (lines 359-408) requires `GROUPS_CLAIM` plus at least
    one list.
  - `makeExternalAuthenticator` (lines 463-494) passes `groups: config.groups`
    and bounds token lifetime with `config.groups ? Math.min(3600, …)`
    (line 482).
  - The `makeAuth` OIDC branch (lines 526-577) chooses between
    `MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS` and
    `MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_SESSION_TTL_SECONDS` (lines 539-546,
    300-3600, default 3600 from `DEFAULT_DERIVED_SESSION_TTL_SECONDS` at
    line 147).
- `spec.ts`: the OIDC group variables are at lines 1300-1360
  (`GROUPS_CLAIM` at 1301, `GROUP_SESSION_TTL_SECONDS` at 1354). The
  `LOGIN_POLICY_BACKEND` description (line 1365) says it is "Mutually
  exclusive with the `MARIMOHUB_AUTH_OIDC_*GROUPS*` variables".
  `LOGIN_POLICY_SESSION_TTL_SECONDS` is at line 1386.
- `index.ts:802-815`: `policyAnalyzer.loginPolicy.evaluate` passes
  `evaluateLoginPolicy`'s result straight through.
- Docs pipeline:
  - `docs/configuration.md` is generated by
    `pnpm --filter @marimo-hub/config docs:generate`
    (`UPDATE_CONFIG_DOCS=1 vp test configDocs`). A drift test fails when it
    is stale.
  - `apps/docs/.vitepress/wizard/__snapshots__/setup.test.ts.snap` embeds
    `docs/setup/auth/oidc.md`, so editing that doc requires a snapshot update.
  - New spec vars must be `optIn: true` with no literal `default:`, or the
    docs wizard emits them.
  - There is no `.env.example`.

**API (`packages/api/src`)**

- `routes/system.ts:36-66`: `GET /api/v1/me` returns `MeResponseSchema`
  (`shared.ts:1433-1446`: `id, email, name, picture_url, logout_url,
  is_super_admin, can_create_projects, app_only?`). Tests are in
  `packages/api/src/me.test.ts`.
- `createApi.ts:496-512`: the authN middleware sets `user` to the principal
  as returned. `refreshIdentity` (`identity.ts:7-25`) calls
  `IdentityService.upsert`. That method
  (`packages/core/src/services/identity/IdentityService.ts:93-120`) persists
  only `email`, `name`, and `picture_url` (`IdentitySchema`,
  `packages/core/src/schema.ts:1319-1328`). New `AuthUser` fields are **not**
  persisted unless that function changes.
- `routes/sessions.ts:644-656`: `entitlementAuthorizationDeadline` returns
  403 when a user has `entitlements` but no `entitlementsExpiresAt`, and
  bounds kernels by that expiry otherwise.
  `mcp/sessionActivity.ts:12-28` folds `principal.entitlementsExpiresAt` into
  the session deadline.
- `routes/policyAnalyzer.ts`:
  - `ExpectedLoginSchema` is at lines 53-61, `LoginStageSchema` at 63-70,
    and `AuthorizationStageSchema` at 131-161 (the subject has
    `entitlement_source: 'explicit' | 'login'` and `entitlements?`).
  - `LoginResultSchema` is at lines 196-205 and the metadata schema at
    283-300.
  - `normalizedEntitlements` is at line 349, `loginAssertion` at 354, and
    `loginResponse` at 366-384.
  - `evaluateCase` (from line 498) builds the subject. Live-self uses
    `{ ...caller, entitlements }`.
  - The analyzer dry-runs **only a login-policy module**. It never runs the
    env-var group mapping.
- `context.ts:354-371`: the `LoginPolicyAnalysisResult` type and
  `PolicyAnalyzerCapability`.

**Other credentials**

- `packages/core/src/services/tokens/TokenService.ts:229-275` (`verify`)
  builds a PAT principal from the identity record (`load`, lines 291-297:
  `{ id, email, name }`). **PATs carry no entitlements today.**
  `ServiceAccountCredentials.ts:125` is similar.
- `packages/auth-dev`, `auth-cloudflare-access`, and `auth-proxy-header`
  build principals without entitlements.
- Job runs (`packages/core/src/services/jobs/*`) do not build an authz
  subject. A grep for `principal|subject` returns nothing.

**Documented promises this plan revises**

- `docs/setup/auth/oidc.md:59`: "The session cookie stores mapped
  entitlements, not raw groups."
- `docs/setup/auth/oidc.md:136-141`: the host "never … writes raw claims into
  the session cookie."
- `development_docs/auth.md:168`: "The session stores mapped entitlements,
  not raw groups."

## Design

**An optional, host-bounded `groups` set on `AuthUser`. OIDC fills it at login
from an operator-selected subset of the groups claim, or from a login-policy
decision. It rides in the signed session with the same ≤ 1 h expiry and
deadline handling as entitlements. Other adapters leave it unset.**

### 1. Core: the bounded group-id contract (`packages/core/src/ports/auth.ts`)

Add the following to `ports/auth.ts`. Adapters already import the focused
`@marimo-hub/core/ports/auth` export, so no new package export is needed.
Keep the code pure, with no zod; `ports/auth.ts` has none today.

```ts
/** 1–128 chars; no control chars, no commas (env lists are comma-separated), no edge whitespace. */
export const AUTH_GROUP_ID_PATTERN =
	/^[^\s,\p{Cc}](?:[^,\p{Cc}]{0,126}[^\s,\p{Cc}])?$/u;
export const MAX_AUTH_GROUPS = 32;
/** UTF-8 bytes of JSON.stringify(sortedGroups); keeps the session JWT under 3800 bytes. */
export const MAX_AUTH_GROUPS_JSON_BYTES = 1280;

export type AuthGroupsProblem = 'groups_not_an_array' | 'invalid_group' | 'too_many_groups';
export function normalizeAuthGroups(
	value: unknown,
): { ok: true; groups: readonly string[] } | { ok: false; problem: AuthGroupsProblem };
export function isAuthGroupId(value: unknown): value is string;
```

`normalizeAuthGroups` does the following, in order:

1. Returns `groups_not_an_array` when the input is not an array.
2. Returns `invalid_group` when any entry fails `isAuthGroupId`.
3. Dedupes the entries.
4. Sorts by code unit with `[...set].sort()`, which gives one canonical
   cookie and `/me` value.
5. Returns `too_many_groups` when the result has more than `MAX_AUTH_GROUPS`
   entries, or when `JSON.stringify(sorted)` exceeds
   `MAX_AUTH_GROUPS_JSON_BYTES` UTF-8 bytes.

The function is total: wrap it in `try` so that a hostile Proxy maps to
`groups_not_an_array`, like `parseLoginPolicyDecision`.

Extend `AuthUser` after line 37:

```ts
/**
 * Bounded IdP group ids selected at login by operator configuration or a
 * login-policy decision — never the raw provider claim. Normalized (deduped,
 * sorted). Shares `entitlementsExpiresAt`; absent when the adapter has no
 * group source.
 */
groups?: readonly string[];
```

Update the line 38 doc comment to: "Expiry of the credential that supplied
group-derived authorization (entitlements and groups)." Add
`groups?: readonly string[]` to `IdentitySubject`
(`packages/core/src/identityMatch.ts:12-16`) so that `AuthSubject` and
`AuthorizationSubject` carry it to 068 and 069.

**This plan adds no consumer in authz.** `effectiveRole` and
`AuthorizationService` stay unchanged. 068 and 069 add the first readers.

**Why 32, why 1280 bytes, why this token:**

- Entra emits GUIDs. In JSON, a GUID takes 38 bytes plus a comma, so 32
  GUIDs come to 1249 bytes, which fits the budget.
- Worst-case session payload: `sub` 512, `email` 320, all 6 entitlements,
  groups 1280, plus `iss`, `aud`, `iat`, `exp`. That is about 2.5 KB of JSON,
  or about 3.4 KB after base64url, header, and signature. This stays under
  `MAX_SESSION_JWT_BYTES = 3800`, and `name` and `picture_url` can still be
  dropped first.
- `SECURITY_LABEL_TOKEN` is rejected because real group ids contain spaces,
  `@`, and a leading `/`.
- Commas are excluded because every group list in config is split on commas.
- 068 and 069 must validate their stored and configured group references
  with `isAuthGroupId`. As a result, any group that fails the token can never
  match a binding.

### 2. OIDC: retain an operator-selected subset (env-var path)

Add a `membership` policy to `OidcGroupPolicy` (`claims.ts:7-20`):

```ts
/** Which claim groups ride in the session as `AuthUser.groups` (exact ids and/or prefixes). */
membership?: { exact?: string[]; prefixes?: string[] };
```

Add two config variables. Both are opt-in and both require
`MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM`:

- `MARIMOHUB_AUTH_OIDC_MEMBERSHIP_GROUPS`: exact, case-sensitive,
  comma-separated group ids, at most 200. Each id must satisfy
  `isAuthGroupId`.
- `MARIMOHUB_AUTH_OIDC_MEMBERSHIP_GROUP_PREFIXES`: case-sensitive
  `startsWith` prefixes, at most 20. Each prefix must satisfy
  `isAuthGroupId`. Examples: `hub-team-` or `/marimohub/`.

In `admitOidcIdentity` (`admission.ts:90-106`), keep the parsed `groups`.
After the `allowed` check and the entitlement mapping, compute the retained
set as follows:

1. Retain a claim group when it equals an `exact` entry or starts with a
   `prefixes` entry.
2. Drop claim groups that fail `isAuthGroupId`, and count them as
   `unretainable`. This drop is safe because no 068/069 binding can name
   such a group.
3. Call `normalizeAuthGroups` on the result. If it returns
   `too_many_groups`, **deny the login** with a new
   `AdmissionFailure 'too_many_groups'`.

Set `user.groups` only when `policy.groups.membership` is configured. It may
be an empty array, which means "membership configured, user is in none".
Leave it undefined otherwise. A missing claim gives `[]`. This matches the
current behavior of `parseGroups(undefined) → []`.

**Why exceeding the cap denies the login instead of truncating:**

- Truncation is fail-closed only while every consumer is purely additive. If
  069 or a later plan ever adds an exclusion-style rule, a dropped group
  fails *open*.
- Partial sets also cause access that depends on sort order and that nobody
  can explain.
- The trigger is an operator misconfiguration (a filter that is too broad).
  The operator can fix it, and the existing precedent is the same: more than
  200 claim groups already fails login (`parseGroups` → `invalid_groups`).
- Log the event and redirect with the generic `auth_failed`. The SPA needs
  no new error code.

Callback (`index.ts:509-515`): on `too_many_groups`, log
`logEvent({ level: 'error', event: 'oidc_membership_groups_exceeded',
retained: n })` and return `callbackError(c, 'auth_failed', returnTo)`.
External access tokens (`accessTokenClaims.ts:72-73`) already map every
non-`auth_failed` admission error to `admission_denied`, so they need no
change there.

`validateGroupPolicy` (`claims.ts:120-133`) must count `membership.exact` and
`membership.prefixes` as policies, so that a membership-only config is valid.
It must also validate those entries with `isAuthGroupId` rather than the
looser `validGroup`. A membership-only config makes `config.groups` truthy,
so the following happen automatically:

- `derivedAuthorization` becomes true (`index.ts:184`). The session gets the
  ≤ 3600 s TTL and the always-present `entitlements: []` marker, so
  `entitlementsExpiresAt` is set.
- The external-token lifetime is clamped (`config/auth.ts:482`).

### 3. Login-policy contract: additive `groups` on allow (no version bump)

- `OidcLoginPolicyDecision` allow (`loginPolicy.ts:42-46`): add
  `readonly groups?: readonly string[]`.
- `OidcLoginPolicyDecisionSchema` allow (lines 109-112): add
  `groups: z.array(z.string()).optional()`. After a successful parse, run
  `normalizeAuthGroups` (`parseDecision`, lines 167-178).
- `LoginPolicyResultProblem` (lines 80-87): add `groups_not_an_array`,
  `invalid_group`, `too_many_groups`, and `groups_on_deny`.
- `problemFromIssues` (lines 119-139):
  - An unrecognized `groups` key on a deny maps to `groups_on_deny`. Extend
    the existing `entitlements_on_deny` check.
  - For `path[0] === 'groups'`, `path.length > 1` maps to `invalid_group`;
    otherwise it maps to `groups_not_an_array`.
- `ParsedLoginPolicyDecision` allow and `LoginPolicyEvaluation` allow
  (lines 89-91 and 224-230) gain `groups: readonly string[]`. It is always
  present and empty when the module returned none. Thread it through
  `evaluateLoginPolicy` (lines 285-286).
- The module's groups are **not** filtered by the membership variables. The
  module is the operator's selection code, and the membership variables join
  `GROUP_POLICY_VARS`, so they are mutually exclusive with a policy (§4).
  The host still enforces the token, count, and byte bounds. A violation is
  an `invalid` outcome, which fails the login closed and logs
  `oidc_login_policy_result_invalid` with the bounded `problem`. The strict
  behavior differs from the env path's "drop unretainable" on purpose: a
  module that returns a malformed group is a contract bug, the same as
  `unknown_entitlement`.
- **`OIDC_LOGIN_POLICY_API_VERSION` stays `1`.**
  - The field is optional and additive, so existing modules are unaffected.
  - `config/library.ts:133` checks the version for exact equality, so a bump
    would break every deployed module at startup.
  - A module that returns `groups` to an older host gets
    `unknown_result_field`, and the login fails closed. Document that the
    field requires marimohub ≥ the release that ships this plan.
- Callback (`index.ts:517-545`): `groups = evaluation.groups` under a policy;
  otherwise `groups = user.groups`.

### 4. Session wire format (`packages/auth-oidc/src/index.ts`)

- `mintSession` (lines 246-251): add
  `...(user.groups !== undefined ? { groups: user.groups } : {})`.
- `signSession` (lines 261-278): groups are an authorization claim and are
  **never dropped**. The existing drop order is `picture_url`, then `name`,
  then throw, and it stays. If the token is still too large, login fails
  through `oidc_session_signing_failed`. The core bounds make this
  unreachable; prove it with a worst-case test (Steps).
- Callback session construction (lines 549-554): pass `groups` when it is
  defined. Under derived authorization, `entitlements` stays the marker, so
  `entitlementsExpiresAt` covers groups too.
- `authenticate` (lines 295-316): if `payload.groups !== undefined`, run
  `normalizeAuthGroups(payload.groups)`. If it is not ok, **return null**,
  log `logEvent({ level: 'error', event: 'oidc_session_groups_invalid' })`,
  and do not accept a partial set. If the `groups` claim is present but the
  `entitlements` marker is absent, also return null, because a group set
  without an expiry is not allowed. On success, spread
  `...(groups ? { groups } : {})`.
- Success telemetry (new): just before `setCookie` (line 559), log
  `logEvent({ level: 'info', event: 'oidc_session_issued', entitlements: n,
  groups: n | null, unretainable: n })`. Log **counts only, never group
  values.** This is the operator signal for how close users are to the cap.
  No successful-login event exists today.
- Rolling deploys:
  - An old replica ignores the new `groups` claim, which is harmless because
    old code has no consumers.
  - A new replica reading an old cookie sees no `groups`, which is the same
    as membership not being configured.
  - The caps are now part of the cookie contract. Raising them later needs a
    two-phase rollout, so record that in the constant's doc comment.

### 5. Config (`packages/config/src/auth.ts`, `spec.ts`)

- Add `'MARIMOHUB_AUTH_OIDC_MEMBERSHIP_GROUPS'` and
  `'MARIMOHUB_AUTH_OIDC_MEMBERSHIP_GROUP_PREFIXES'` to `GROUP_POLICY_VARS`
  (lines 270-280). This keeps the login policy mutually exclusive with every
  group variable; a policy returns `groups` itself.
- In `parseGroupPolicy` (lines 359-408):
  - Parse both variables.
  - Validate every entry with `isAuthGroupId`. Raise a `ConfigError` naming
    the variable and the rule ("1–128 characters, no control characters or
    commas, no leading or trailing whitespace"). Allow at most 200 exact ids
    and 20 prefixes.
  - Include them in `mappedPolicy` (line 367).
  - Emit `membership: { exact?, prefixes? }`.
  - A variable that is set but empty is an error, mirroring
    `parseLoginAllowedGroups` (lines 346-357).
- `spec.ts`:
  - Add two entries after `MARIMOHUB_AUTH_OIDC_DEFAULT_MANAGER_GROUPS`
    (line 1348). Both get `optIn: true`, no `default:`, and an `example`
    (`hub-team-data,hub-team-ml` and `hub-team-`).
  - The descriptions must state four facts: the selected groups ride in the
    signed (not encrypted) session; the session holds at most 32 groups /
    1280 bytes; exceeding the bound denies login; there is no effect until
    068/069 bindings use them.
  - Update the `LOGIN_POLICY_BACKEND` description (line 1365) to say that a
    module may return `groups`.
  - Leave the TTL variables unchanged. Groups reuse
    `…GROUP_SESSION_TTL_SECONDS` or `…LOGIN_POLICY_SESSION_TTL_SECONDS`, both
    ≤ 3600, so no new TTL variable is added.

### 6. API surface

- `MeResponseSchema` (`shared.ts:1433-1446`): add
  `groups: z.array(z.string())`, a required field that is always emitted and
  empty when there are none. Add a short doc comment saying the field holds
  group ids carried by the current credential and that it is empty for PATs,
  service accounts, and non-OIDC backends. `routes/system.ts:56-65` emits
  `groups: [...(user.groups ?? [])]`. Adding a response property is
  non-breaking for oasdiff.
- `routes/sessions.ts:644-656`: change the no-expiry guard to
  `if (user.entitlements?.length || user.groups?.length)`. A group-bearing
  credential without an expiry must not start a kernel. This keeps the
  invariant 068 and 069 rely on: group-derived access always has a deadline.
- `routes/policyAnalyzer.ts`:
  - `ExpectedLoginSchema` allow (lines 55-58) gains
    `groups: z.array(z.string()).max(MAX_AUTH_GROUPS).optional()`.
    `loginAssertion` (line 354) compares groups as sorted sets when the
    expectation sets them.
  - `LoginResultSchema` (lines 196-205) gains `groups: z.array(z.string())`.
    `loginResponse` (lines 366-384) emits `result.groups` on allow and `[]`
    otherwise.
  - The `AuthorizationStageSchema.subject` (lines 133-139) gains
    `groups: z.array(z.string().refine(isAuthGroupId)).max(MAX_AUTH_GROUPS).optional()`.
  - In `evaluateCase`, mirror the entitlements logic: linked login uses
    `loginEvaluation.groups`, explicit uses `stage.subject.groups ?? []`, and
    the live-self branch spreads `{ ...caller, entitlements, groups }`.
  - Metadata (lines 283-300) gains `max_groups: z.number().int().positive()`.
  - `PolicySuiteV1Schema.schema_version` stays `1`, because the new request
    fields are optional.
- `context.ts:354-360`: the `LoginPolicyAnalysisResult` allow variant gains
  `groups: readonly string[]`. `config/src/index.ts:806-812` passes the value
  through unchanged, so it type-checks once loginPolicy.ts is updated.

### 7. Credential kinds

| Credential               | `groups` in v1                                     |
| ------------------------ | -------------------------------------------------- |
| `sso` (OIDC)             | yes, from the claim filter or the login policy     |
| `external-access-token`  | yes: same `admitOidcIdentity`, bounded by the token's `exp` via `entitlementsExpiresAt` (`accessTokenClaims.ts:79`) |
| `personal-access-token`  | **no** (consistent with entitlements today)        |
| `service-account`        | no                                                 |
| `development`            | no (dev override is a follow-up)                   |
| `sso` (cloudflare-access, proxy-header) | no (follow-up)                      |

There is no inheritance at PAT mint time. `TokenService.verify` builds the
principal from the identity record, and the record holds no groups. 068 and
069 must document that **group-derived access does not apply to PATs, service
accounts, or background work**, which matches entitlements today
(`docs/setup/auth/oidc.md:95-97`). A CI user who needs project access through
a PAT needs an explicit membership, or a service account with explicit
membership (070).

### Why session-carried groups are acceptable now (vs. 049)

049 rejected persisting groups and put only mapped entitlements in the
cookie. That was right for 049, because a fixed enum of deployment-wide
grants **can** be pre-computed at login. 068 and 069 cannot be pre-computed
that way:

- A group's effective access depends on **request-time project state**:
  membership rows (068) and project tags matched by rule prefixes (069).
  Both change after login, so login cannot reduce them to a fixed
  entitlement.
- This is still not "raw claims in the cookie":
  - The retained set is either an operator-selected subset (exact list or
    prefixes) or the output of operator code (the policy).
  - It is bounded by count, bytes, and token.
  - The host normalizes it and re-validates it on every request.
  - It shares the ≤ 1 h deprovisioning bound and the kernel-deadline
    machinery already used for entitlements.
- 049's "no group data stored server-side" still holds. The identity
  directory is untouched, and the only copy is the user's own
  expiring, signed cookie.
- **Confidentiality:** the cookie is HttpOnly but not encrypted, and `/me`
  returns the groups to the user. Only groups the operator chose to retain
  are exposed, and Entra ids are opaque GUIDs. With the authorization-code
  flow the browser never saw the ID token, so this is new exposure to the
  user themselves. Document it, and tell operators not to retain groups
  whose names are sensitive.
- **Separation from subject context:** groups are coarse membership, used
  additively for roles. They must **never** satisfy security labels or feed
  `SubjectSecurityContext` compartments. Those still come only from the
  subject-context port, as `subjectContext.ts:1-27` requires. Add one
  sentence to that header that cross-references this boundary.

## Rejected

- **Persisting a bounded, expiring group snapshot in
  `_system/identities/{uid}.json`** (`IdentitySchema`, schema.ts:1319;
  `IdentityService.upsert`, the single writer).
  - Pro: PATs, service accounts, and background work could resolve groups.
  - Con: it adds a CAS write on the login path whenever groups change.
    Today the write is skipped by `IdentityService.signature`.
  - Con: it creates a server-side copy of IdP state that can drift. That is
    the duplication 049 rejected.
  - Con: it forces a PAT freshness rule. Either the PAT's groups expire one
    hour after the user's last browser login (a PAT that silently stops
    working), or they never expire (deprovisioning is never honored).
  - Revisit with SCIM Groups or an explicit "PAT inherits groups until
    `groups_expires_at`" product decision. See Follow-ups.
- **Re-resolving groups per request from the IdP** (Graph or Okta APIs):
  this needs a vendor client in the request path, adds latency and rate
  limits, and needs a port of its own. It is out of scope.
- **Deterministic truncation to N groups:** see §2. It silently drops grants
  and is not fail-closed against future exclusion rules.
- **Carrying the whole claim (≤ 200 × 256 chars):** it exceeds the cookie
  limit and puts unselected, possibly sensitive names in the cookie.
- **HMAC-hashing group ids in the cookie:** it makes `/me` and the analyzer
  useless, and 068/069 would have to hash every stored reference with the
  session secret, which ties stored data to secret rotation.
- **Bumping `OIDC_LOGIN_POLICY_API_VERSION` to 2:** the exact-match loader
  check would break every deployed module for an optional field.
- **Letting the membership variables also filter policy-returned groups:**
  that recreates the AND/OR composite ambiguity that `parseLoginPolicy`'s
  mutual exclusion exists to prevent (`config/auth.ts:283-287`).
- **Encrypting the session (JWE):** it is a larger change, touches every
  replica's cookie format, and does not stop `/me` exposure. Revisit only if
  sensitive groups become a requirement.

## Steps

1. **Core contract**
   - In `packages/core/src/ports/auth.ts`, add `AUTH_GROUP_ID_PATTERN`,
     `MAX_AUTH_GROUPS`, `MAX_AUTH_GROUPS_JSON_BYTES`, `AuthGroupsProblem`,
     `isAuthGroupId`, `normalizeAuthGroups`, and `AuthUser.groups`, and
     update the line 38 doc comment.
   - Add `IdentitySubject.groups` in `identityMatch.ts`.
   - Add one boundary sentence to the `subjectContext.ts` header.
   - Tests go in the existing `packages/core/src/ports/auth.test.ts`.
     Cover:
     - Entra GUIDs, Okta names with spaces, Keycloak `/a/b`, Google
       `team@corp.com`.
     - Rejects: comma, control char, leading or trailing space, empty, and
       129 characters.
     - Dedupe and sort.
     - 32 entries pass and 33 fail.
     - A 1280-byte set passes and 1281 bytes fails, including multibyte and
       JSON-escaped `"`/`\` cases.
     - A non-array input, and a throwing Proxy, give `groups_not_an_array`.
2. **auth-oidc admission**
   - `claims.ts`: add `OidcGroupPolicy.membership`, have
     `validateGroupPolicy` count and validate it, and add a pure
     `retainMembershipGroups(groups, membership)` that returns
     `{ retained, unretainable }`.
   - `admission.ts`: add `AdmissionFailure 'too_many_groups'` and set
     `user.groups` only when membership is configured. Return an
     `unretainable` count for telemetry: extend the success result to
     `{ user, groupStats? }`. Keep the stats off `AuthUser`.
   - Extend `admission.test.ts` for: exact match, prefix match, both, no
     membership config (`groups` undefined), a missing claim (`[]`), over the
     cap (deny), a non-token group under a prefix (dropped and counted), and
     `allowed` and entitlement mapping unchanged.
   - Extend `accessTokens.test.ts` and `accessTokenClaims.test.ts`: an
     external token principal carries `groups` and `entitlementsExpiresAt`,
     and over the cap gives `admission_denied`.
3. **auth-oidc login policy**
   - `loginPolicy.ts`: make the schema, type, problem, parse, and evaluation
     changes from §3, and leave `OIDC_LOGIN_POLICY_API_VERSION = 1` with a
     comment that the `groups` field is additive.
   - Extend `loginPolicy.test.ts` for each new problem category,
     `groups_on_deny`, normalization (dedupe and sort), a missing field
     giving `groups: []`, and an unknown-field precedence case.
4. **auth-oidc session**
   - `index.ts`: make the `mintSession`, `signSession` call site,
     `authenticate`, callback (`too_many_groups` log + `auth_failed`; policy
     groups), and `oidc_session_issued` counts changes from §4.
   - Extend `index.test.ts` for:
     - The round-trip: login, then `authenticate` returns `groups` and
       `entitlementsExpiresAt`.
     - A cookie without `groups` gives undefined.
     - A tampered or oversize `groups` claim (re-signed with the test
       secret) gives null.
     - `groups` without the `entitlements` marker gives null.
     - **The worst-case size**: a 512-character `sub`, a 320-character email,
       all 6 entitlements, and 32 groups totaling 1280 bytes sign within
       `MAX_SESSION_JWT_BYTES` after dropping name and picture.
     - The `oidc_session_issued` event carries counts and no group strings.
5. **Config**
   - `packages/config/src/auth.ts`: add the two variables to
     `GROUP_POLICY_VARS`, update `parseGroupPolicy`, and pass `membership`
     through.
   - `spec.ts`: add the two entries and update the `LOGIN_POLICY_BACKEND`
     description.
   - Extend `auth.test.ts`:
     - The membership-only config is valid, gets a TTL ≤ 3600, and is
       derived.
     - The variables without `GROUPS_CLAIM` raise a ConfigError.
     - Each variable combined with `LOGIN_POLICY_BACKEND=library` raises a
       ConfigError.
     - An invalid token (comma impossible; space-edged, control char, or
       129 characters) raises a ConfigError naming the variable.
     - More than 200 exact ids or more than 20 prefixes raises a
       ConfigError.
     - A set but empty variable raises a ConfigError.
   - Extend `externalTokens.test.ts`: membership-only config clamps the
     token lifetime to ≤ 3600.
   - Regenerate the config docs with
     `pnpm --filter @marimo-hub/config docs:generate`.
6. **API**
   - `shared.ts`: add `MeResponseSchema.groups`.
   - `routes/system.ts`: emit `groups`.
   - `routes/sessions.ts:644-656`: apply the guard change.
   - `routes/policyAnalyzer.ts` and `context.ts`: apply the §6 changes.
   - Tests:
     - `me.test.ts`: a principal with groups returns sorted groups; one
       without returns `[]`.
     - Sessions tests: a principal with `groups` and no
       `entitlementsExpiresAt` gets 403 on session start; with an expiry,
       the kernel deadline is bounded.
     - Policy analyzer tests: login `groups` expectation pass and fail; a
       linked authorization subject inherits login groups; explicit
       `groups` validation rejects a comma or control character; metadata
       includes `max_groups`.
   - Fix the web and API test fixtures that build `Me` objects, which must
     add `groups: []`. Find them with
     `grep -rln can_create_projects packages/web/src packages/api/src`.
   - Run `pnpm schemas:generate` to regenerate `packages/api/openapi.yaml`,
     the CLI, and `packages/client`, and confirm the oasdiff result is
     non-breaking.
7. **Example module**
   - `examples/external-adapter/oidc-login-policy.mjs` and its `.test.mjs`:
     show flattening a department claim into team groups (for example,
     return `groups: [`team-${claims.team}`]`) with a comment about the
     bounds.
8. **Docs**
   - `docs/setup/auth/oidc.md`:
     - In §"Groups and roles", add a "Group membership" subsection: the two
       variables, the exact vs. prefix semantics, the 32-group / 1280-byte
       bound, deny on overflow, `/me` exposure, PATs excluded, and a note
       that nothing uses the groups until 068/069 bindings exist.
     - Replace the line 59 sentence with: "The session stores mapped
       entitlements and, when membership groups are configured, only the
       selected group ids — never the full claim."
     - For Entra: recommend "Groups assigned to the application" to avoid
       overage, which omits the claim and yields no groups.
     - In §"Login-policy module", document `groups` on allow, the bounds,
       the new problem categories, and the minimum host version. Revise the
       "never … writes raw claims" sentence (lines 136-141) to cover
       module-selected groups.
   - `development_docs/auth.md:154-170`: update the cookie section to the
     same effect.
   - Update `docs/auth.md` and `docs/security.md` wherever they describe
     cookie contents (grep `raw groups|session cookie`).
   - `development_docs/ports.md`: if it documents the login-policy result
     shape, add `groups`.
   - Update the wizard snapshot with
     `pnpm --filter @marimo-hub/docs exec vp test -u`.
9. **Review the diff and strip AI-slop comments.** Remove narration,
   restatements, and doc blocks that only repeat the signature. Keep only
   *why* comments, such as the cap and the two-phase-rollout invariant, the
   deny-not-truncate rationale, and the no-version-bump rationale.

## Verification

- Package tests:
  `pnpm --filter @marimo-hub/core test`,
  `pnpm --filter @marimo-hub/auth-oidc test`,
  `pnpm --filter @marimo-hub/config test`,
  `pnpm --filter @marimo-hub/api test`, and `pnpm --filter @marimo-hub/web test`
  (for the fixtures).
- `pnpm schemas:generate`, then confirm `git diff --stat` shows only the
  expected additions to `packages/api/openapi.yaml`, the CLI, and the client.
  Then run `pnpm --filter @marimo-hub/config docs:generate` and
  `pnpm --filter @marimo-hub/docs exec vp test -u`.
- Root: `pnpm check && pnpm typecheck && pnpm test && pnpm build`.
- Manual check with a Keycloak dev realm or Okta preview:
  1. Set `GROUPS_CLAIM=/groups` and `MEMBERSHIP_GROUP_PREFIXES=hub-team-`.
  2. Sign in as a user in `hub-team-a`, `hub-team-b`, and `other`. Expect
     `GET /api/v1/me` → `groups: ["hub-team-a","hub-team-b"]`.
  3. Check that the cookie is under 3800 bytes.
  4. Check that the logs show `oidc_session_issued` with `groups: 2` and no
     names.
  5. Add 33 matching groups. Expect login to redirect with
     `auth_error=auth_failed` and to log `oidc_membership_groups_exceeded`.
  6. Create a PAT and call `/me` with it. Expect `groups: []`.
- With a login-policy module that returns `groups`:
  1. A valid set appears in `/me`.
  2. `groups: ["a,b"]` fails login, and the logs show
     `problem: invalid_group`.
  3. The policy analyzer shows the groups on a dry run.

## STOP conditions

- **Cookie size:** if the worst-case test in Step 4 cannot fit
  `MAX_SESSION_JWT_BYTES` with these bounds, STOP. Lower
  `MAX_AUTH_GROUPS_JSON_BYTES` and report. Do **not** raise
  `MAX_SESSION_JWT_BYTES`, and do not drop groups in `signSession`.
- **Raw claims leaking:** STOP if any path writes unselected claim groups or
  group values into the cookie, a log or audit line, `IdentityService`, or
  any bucket object. This includes logging the `unretainable` *values*
  rather than the count, and spreading `AuthUser` wholesale into a persisted
  record. The identity directory must not store groups in v1.
- **Overriding explicit membership:** this plan adds no authz consumer. If
  wiring `groups` changes any `effectiveRole` or `AuthorizationService`
  result in existing tests, STOP. Group-derived access belongs to 068 and
  069 and must never override explicit membership, ownership, or security
  labels.
- If `groups` would need to feed `SubjectSecurityContext` or label checks to
  satisfy a test or caller, STOP. That is the subject-context port's job.
- If keeping the login policy and the membership variables mutually
  exclusive breaks an existing deployment test, STOP and report rather than
  relaxing the exclusivity.
- If a background or delegated path (job runs, MCP OAuth grants, previews)
  turns out to re-authorize as a stored user and would need groups, note it
  for 068/069 and do not add a groups source here.

## Follow-ups (out of scope)

- **068 / 069** consume `AuthUser.groups`. Both must validate their stored
  and configured references with `isAuthGroupId` and must state that groups
  are additive only.
- **PAT and service-account groups:** a persisted, expiring group snapshot
  owned by `IdentityService`, or SCIM Groups. This needs a product decision
  on PAT freshness (see Rejected).
- **cloudflare-access:** read groups from the Access JWT (`groups` claim or
  identity endpoint) into the same bounded set.
- **proxy-header (JWT mode):** an optional groups claim pointer.
- **Dev backend:** a `MARIMOHUB_AUTH_DEV_GROUPS` override for local 068/069
  testing.
- **Policy analyzer:** dry-run the env-var group policy (allowed,
  entitlement lists, membership) in addition to a login-policy module.
- **Entra group overage:** resolve `_claim_names` / `hasgroups` through
  Graph behind a port, only if customers cannot use app-assigned groups.
- **SPA:** show the caller's groups on the account/profile page, which 068
  needs for "why do I have access".
