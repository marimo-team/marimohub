# Plan 069: Deployment access rules (IdP group → role over tag prefixes / project ids)

> Issue marimo-team/marimohub#456 asks for org → department → team → project
> inheritance of membership. Plans 066–071 answer it **without a nested
> project entity**: tag paths are the namespace (066), the OIDC adapter carries
> bounded IdP group ids on the subject (067), groups can be explicit member rows
> (068), and **this plan adds the inheritance layer**: operator-configured rules
> such as "group `dep1-leads` is `manager` on every project under `dep1`". 070
> covers provisioning and 071 covers listing at scale.
>
> Rules are deployment configuration (env / IaC), evaluated purely in core,
> and they only **add** access. They never override an explicit membership row,
> they never grant `admin`, and labels and credential scopes still apply.

## Status

- **Priority**: P2 (enterprise access control; the "inheritance" ask in #456)
- **Effort**: M (Phase 1). Phase 2 (library PDP backend) is a separate M.
- **Risk**: MED-HIGH. This plan changes `resolveEffectiveRole`, which every
  project, session, and kernel-proxy decision uses. An ordering mistake is a
  privilege bug.
- **Depends on**: **067 (hard)** for `subject.groups`. **066 (soft)** for tag-path
  normalization and `tag_prefix` semantics. A local fallback is specified in
  Step 1 if 066 has not landed.
- **Composes with**: 068 (group member rows are *explicit membership*, so they
  rank above rules, like any member row). 071 (list scale: see "Listing" below).
- **Category**: auth / access-control
- **Planned at**: 2026-10-07

## Current state (verified 2026-10-07)

- **Role resolution**: `packages/core/src/authz.ts`
  - `RANK` (line 27) and `ENTITLEMENT_ROLE` (28–33).
  - `subjectDefaultRole(subject, policy)` (39–49): the max of
    `policy.defaultRole` and the `default-role:*` entitlements. It feeds
    `/capabilities.default_role` (`packages/api/src/routes/system.ts:170`),
    `listsAllProjects`, `canSeeProjectEntry`, and `ProjectService.isAppOnly`.
  - `AuthzPolicy` (63–69): `defaultRole`, `superAdmins`, `projectCreationRestricted`.
  - `EffectiveRoleSource` (71–79): `static-super-admin | entitlement-super-admin |
    owner | member-id | member-email | entitlement-default | deployment-default | none`.
  - `resolveEffectiveRole(project, subject, policy)` (130–178). Order:
    entitlement super-admin (135) → static super-admin (138) → owner (141) →
    explicit membership, max rank, id row beats email row on a tie (142–158,
    **returns immediately**) → entitlement default vs deployment default (160–173):
    `deploymentRole >= entitlementRole` → `deployment-default`, otherwise
    `entitlement-default` → deployment default alone (174–176) → `none`.
  - `canSeeProjectEntry(entry, subject, policy)` (222–237): a snapshot-only
    visibility check. Its only production caller is
    `AuthorizationService.projectEntryVisibility` (`AuthorizationService.ts:692–706`),
    and nothing in `packages/*/src` calls that outside tests.
- **Every role decision goes through `resolveEffectiveRole` with `deps.policy`**:
  `AuthorizationService.decideBaseline` (`AuthorizationService.ts:579`),
  `AuthorizationService.role` (652), `effectiveRole` in
  `packages/api/src/routes/projects.ts:141` (`projectResponse`) and `:498`
  (`listMembers`), `packages/api/src/mcp/selectors.ts:33`, and
  `ProjectService.entryRole` (`ProjectService.ts:302`). So rules that ride on
  the policy object reach every surface, including the sandbox proxies, with no
  per-route change.
- **Subject shape**: `IdentitySubject` (`packages/core/src/identityMatch.ts:12–16`)
  is `{ id, email, entitlements? }`. `AuthSubject = IdentitySubject`
  (`authz.ts:56`). **There is no `groups` field today.** OIDC groups exist only
  as mapped `entitlements` (`packages/core/src/ports/auth.ts:13–22,36–39`), with
  `entitlementsExpiresAt` bounding them. Plan 067 adds
  `groups?: readonly string[]`.
- **Policy plumbing**: `PolicyConfig` (`packages/api/src/context.ts:270–323`) is
  structurally assignable to `AuthzPolicy` and to `AuthorizationPolicy`
  (`AuthorizationService.ts:65–68`). Config builds it in
  `packages/config/src/index.ts:776–794` (`defaultRole: parseDefaultRole(env)`
  at 778, `superAdmins` at 782, `projectCreationRestricted` at 783).
  `parseDefaultRole` is at `index.ts:507`.
  `examples/cloudflare-worker/src/index.ts:208–214` builds its own policy and is
  out of scope.
- **Precedent rule shape**: `packages/core/src/projectResourcePolicy.ts` (1–25):
  a strict zod `{ resource, projects: '*' | ProjectId[] }` and
  `parseProjectResourceRules`. It is exported as
  `@marimo-hub/core/project-resource-policy` (`packages/core/package.json:49`).
  Config parses it in `packages/config/src/projectResourcePolicy.ts` (1–24) and
  throws `ConfigError` on malformed JSON. The env vars are
  `MARIMOHUB_SOURCE_CONTROL_GITHUB_ALLOWED_REPOSITORIES` (`spec.ts:1869`) and
  `MARIMOHUB_SECRETS_AWS_ALLOWED_SECRETS` (`spec.ts:2112`).
- **Tags**: `Project.tags: string[]` is required on `project.json`
  (`schema.ts:439`). `SnapshotProjectEntry.tags` is optional (`schema.ts:248`) and
  missing on legacy entries. The projection is written by `projectCatalogPatch`
  (`packages/core/src/services/content/catalogProjection.ts:79–88`). Tags are
  **unvalidated free strings** today, with no charset, length, or count bound
  (066 adds path normalization).
- **Who can write tags**: `CreateProjectBody.tags` (`routes/projects.ts:64–72`),
  so any project creator can, and `UpdateProjectBody.tags` (74–82), gated by
  `project.update` = `manager` (`actions.ts:136`). The `updateProject` handler is
  at `routes/projects.ts:409–419`. `ProjectService.updateProject`
  (`ProjectService.ts:399–435`) replaces the whole array (`input.tags ?? current.tags`,
  line 421) inside a `mutateObject` CAS, then commits catalog operation
  `'project.update'` (430). `createProject` sets `tags: input.tags ?? []` (352).
  The web SPA does not edit project tags (only notebook tags,
  `packages/web/src/components/Project/NotebookTags.tsx`). Callers:
  `routes/projects.ts:392`, `services/index.ts:686` (bootstrap default
  project), and `api/src/testing/mcp.ts:45`.
- **Label-gate precedent**: `PUT|DELETE /projects/{pid}/security-labels`
  (`routes/projects.ts:241–285`, `security: SESSION_ONLY_SECURITY`). The handler
  `mutateSecurityLabels` (429–465) calls `assertSessionAuthenticated` and maps the
  change to `security-labels.raise|lower` (`actions.ts:149–159`,
  `requiresSuperAdmin: true`). It pins the write to the version it read
  (`ifMatchToken(c) ?? project.updated_at`). The audit trail is a catalog commit
  with context (`ProjectService.ts:509–518`: operation `'project.security_labels'`,
  `{ project_id, previous_labels, next_labels }`).
  `CatalogService.updateProjectEntry(operation, actor, pid, patch, context)`
  (`CatalogService.ts:317–339`) appends `{ event: operation, actor, ...context }`
  to the event log (300–305).
- **Listing**: `ProjectService.listProjects` (`ProjectService.ts:224–284`)
  already loads `project.json` for **every** non-owner, non-super-admin entry
  through `entryRole` (286–307), on purpose: "a roster projection can lag ... a
  miss cannot prove that a more restrictive explicit membership is absent."
  `isAppOnly` (309–327) uses `subjectDefaultRole` as its fast fallback.
  `AuthorizationService.listsAllProjects` (672–684) uses
  `subjectDefaultRole ≥ viewer || super admin` and also backs `directory.search`
  (770).
- **Session deadlines**: `entitlementAuthorizationDeadline`
  (`packages/api/src/routes/sessions.ts:644–656`) and
  `sessionAuthorizationDeadline` (`packages/api/src/mcp/sessionActivity.ts:12–27`)
  bound kernel sessions by `entitlementsExpiresAt`. Group-derived rule access
  needs the same bound.
- **Policy analyzer**: `packages/api/src/routes/policyAnalyzer.ts`. The
  `AuthorizationStageSchema.subject` (131–139) has `id, email,
  entitlement_source, entitlements, grant`, and no groups.
  `SyntheticProjectSchema` (82–87) has no tags, and `syntheticProject` (386–400)
  hard-codes `tags: []`. The trace step `role` carries
  `code: effective_role_${source}` and `details: { role, entitlements }`
  (`AuthorizationService.ts:581–586`). Metadata capabilities are at 283–302 and
  639.
- **Admin policy summary**: `AdminPolicySchema` (`packages/api/src/shared.ts:1513–1519`)
  is built at `packages/api/src/routes/admin.ts:908–911`.
  `CapabilitiesSchema.default_role` is at `shared.ts:1621`.
- **Library adapters** (Phase 2): `packages/config/src/library.ts`.
  `LoadedAdapterLibraries` (33–38), `LIBRARY_CONFIG` (41–66) with kinds
  `storage | compute | oidc-login-policy | subject-security-context`,
  `validateManifest` (113–140) checking `{ apiVersion, kind, create }`, and
  `loadMethodAdapter` (381–416), whose kind union is
  `'oidc-login-policy' | 'subject-security-context'`. `loadAdapterLibraries` is
  at 469. `ADAPTER_API_VERSION = 1` is in
  `packages/core/src/ports/externalAdapter.ts:5`, and
  `SUBJECT_CONTEXT_ADAPTER_API_VERSION = 1` is in
  `packages/core/src/ports/subjectContext.ts:82`. The fail-closed precedent is
  `subjectContext.ts` (strict schema, `validate*` → null, expiry, a provider
  that throws = no context) plus `SECURITY_EVENTS` (`AuthorizationService.ts:183–192`).
- **Docs**: `docs/auth.md` "Authorization roles" (66) and "Default access for
  non-members" (155–166). `docs/security.md` "Authorization (roles)" (165),
  "Project reads require ..." (204), "Applying labels" (226).
  `development_docs/bucket_spec.md` §12 (1359; the AuthZ bullets are at
  ~1376–1380). `development_docs/auth.md` "Policy analyzer" (274).
  `docs/configuration.md` is generated from `spec.ts` by
  `pnpm --filter @marimo-hub/config docs:generate`
  (`UPDATE_CONFIG_DOCS=1 vp test configDocs`). The wizard snapshots are in
  `apps/docs/.vitepress/wizard/__snapshots__/generate.test.ts.snap`. The env
  example is `apps/server/.env.example` (the authz block is around lines 112–116).
  The authz spec entries live in the `Server / API` group (`spec.ts:1490`):
  `MARIMOHUB_DEFAULT_ROLE` (1624), `MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER`
  (1656), `..._SUBJECT_CONTEXT_BACKEND` (1666), `..._SUBJECT_CONTEXT_LIBRARY`
  (1676), and `MARIMOHUB_VIEWER_MODE` (1686).

## Design

### Rule shape (core, pure)

New file `packages/core/src/accessRules.ts`, exported as
`"./access-rules": "./src/accessRules.ts"` in `packages/core/package.json`
(beside `./project-resource-policy`). It is also re-exported from
`packages/core/src/index.ts` next to `export * from './authz'` (line 9) so that
`authz.ts` and `api` can use it.

```ts
export const MAX_ACCESS_RULES = 256;
export const MAX_ACCESS_RULE_PROJECTS = 1000;

const projects = z.union([
	z.literal('*'),
	z.array(z.string().refine(ProjectId.is)).min(1).max(MAX_ACCESS_RULE_PROJECTS),
	z.strictObject({ tag_prefix: TagPathPrefixSchema }), // 066's PATH_TAG_PATTERN + MAX_TAG_PREFIX_LENGTH; trailing '/' rejected
]);

const AccessRuleSchema = z.strictObject({
	projects,
	group: z.string().refine(isAuthGroupId), // 067's AUTH_GROUP_ID_PATTERN (1–128 chars, no commas / control chars)
	role: z.enum(ASSIGNABLE_ROLES),      // never 'admin'
});
export type AccessRule = z.infer<typeof AccessRuleSchema>;

export function parseAccessRules(value: unknown): AccessRule[];   // z.array(...).max(MAX_ACCESS_RULES).parse
export interface AccessRuleMatch { index: number; group: string; role: AssignableRole; via: 'all' | 'project-id' | 'tag-prefix' }
export interface AccessRuleTarget { id: ProjectId; tags?: readonly string[] }

/** null result = indeterminate: a tag_prefix rule names a subject group but tags are unknown. */
export function resolveAccessRuleRole(
	rules: readonly AccessRule[] | undefined,
	subject: { groups?: readonly string[] },
	target: AccessRuleTarget,
): { role: AssignableRole | null; matches: AccessRuleMatch[] } | null;

export function accessRuleRole(...same): AssignableRole | null;     // project.json form; tags always present
export function wildcardAccessRuleRole(rules, subject): AssignableRole | null; // only `projects: '*'`
export function namespaceTags(tags: readonly string[], prefixes: readonly string[]): string[]; // sorted, deduped
```

- A `tag_prefix` must itself be a path tag under 066's grammar, so
  `{"projects":{"tag_prefix":"dep1/"},...}` is rejected at startup (trailing
  `/`), and the operator writes `dep1`. Under 066 semantics, `dep1` matches `dep1` and `dep1/...`, but
  not `dep10`. If 066 has not landed, implement
  `tagMatchesPrefix(tag, prefix) = tag === prefix || tag.startsWith(prefix + '/')`
  in `accessRules.ts`, and add a `TODO(066)` to replace it with 066's export.
  Prefix validation in that fallback: non-empty, ≤128 chars, no leading `/`, no
  empty segment, no control chars. The prefix `*` is rejected (use
  `projects: "*"`).
- Group matching is **exact string equality** against `subject.groups`. There
  is no case folding, because IdP group ids are opaque (Entra object ids, Okta
  ids) and the existing `MARIMOHUB_AUTH_OIDC_*_GROUPS` variables are exact too
  (`spec.ts:1309`).
- `subject.groups === undefined` (PAT, service account, external token,
  dev-bypass, proxy headers) means no rule matches. This mirrors "OIDC
  group-derived status ... does not transfer to PATs" (`bucket_spec.md` §12).
- Evaluation is the **max rank** across matching rules, like membership and
  entitlements. `matches` lists every matching rule in index order, for the
  analyzer.

### Where rules slot into `resolveEffectiveRole`

`AuthzPolicy` gains `accessRules?: readonly AccessRule[]` and
`namespaceTagPrefixes?: readonly string[]`. `EffectiveRoleSource` gains
`'access-rule'`. `EffectiveRoleResolution` gains an optional
`accessRuleMatches?: readonly AccessRuleMatch[]`, filled whenever any rule
matched, even when another source won the rank.

| # | Source | Role | Stops? |
|---|--------|------|--------|
| 1 | `entitlement-super-admin` | admin | yes |
| 2 | `static-super-admin` | admin | yes |
| 3 | `owner` | admin | yes |
| 4 | `member-id` / `member-email` (incl. 068 group rows) | max member role | **yes, even when a rule would grant more** |
| 5 | max of { `access-rule`, `entitlement-default`, `deployment-default` } | highest rank | yes |
| 6 | `none` | null | — |

Row 5 tie-break for the reported source: `access-rule` > `deployment-default` >
`entitlement-default`. The last two keep today's tie behavior (`authz.ts:169`).
The access rule wins a tie because it is the most specific evidence for the
analyzer.

**Contradiction with the brief, resolved here:** the brief says to place rules
"BEFORE entitlement/deployment defaults (rules are more specific)." A strict
first-match would let a rule **downgrade** access. The shipped
`MARIMOHUB_DEFAULT_ROLE` default is `editor` (`spec.ts:1624–1630`), so an
`all-staff → viewer` rule would make every staff member a viewer, which is a
silent regression. Rules are grants. Restriction belongs to labels and
credential scopes. So rules merge by max rank with the defaults, and they
still never override an explicit row (row 4 returns first). This keeps plan
049's guarantee: explicit membership is never overridden by a broader source.
Config logs a startup warning when every rule's role ranks at or below the
effective `MARIMOHUB_DEFAULT_ROLE`, because those rules then have no effect.
The docs tell operators to pair rules with `MARIMOHUB_DEFAULT_ROLE=none` or
`app-user`.

Explicit-row semantics stay unchanged: an explicit `viewer` (or `app-user`)
row caps the user on that project, even if a rule grants `manager`. This is the
documented way to carve one project out of a namespace grant. A project
manager can therefore *reduce* a rule-granted user to viewer on their own
project. That is consistent with how managers already control member rows, and
the analyzer shows it.

### Namespace-tag integrity (decision: option (a), plus steward delegation)

The problem: a `tag_prefix` rule turns a project's tags into an authorization
input. The tags can be written today by any project creator (on create) and
any project manager (on PATCH).

- **(c) Accept it.** The argument for it is that a manager can already grant
  anyone anything through member rows, so adding a namespace tag grants nothing
  the manager couldn't grant directly. That half holds. The new risk is the
  other direction: **removing** inherited oversight. Today a project manager
  cannot remove a department's access, because that access does not exist. With
  rules, `dep1-leads: manager` / `dep1-auditors: viewer` is the organization's
  control, and with (c) any project manager (including a team member granted
  manager by a narrower rule or row) can retag `dep1/team1 → misc` and silently
  remove department leads and auditors. #456 is exactly the request that
  departments keep standing access to their subtree. With (c) that guarantee
  would be advisory. A second, smaller risk: under open creation any user can
  create a project tagged `dep1/...` and push content into dep1 staff's
  listings and app surfaces (namespace spoofing).
- **(b) Project ids only.** This is safe but defeats the purpose (no
  inheritance for new projects). It stays available as a rule form.
- **(a) Protected namespace tags. Chosen.** A tag is a *namespace tag* when it
  matches any prefix in `policy.namespaceTagPrefixes`. That set is the union of
  `MARIMOHUB_AUTHZ_NAMESPACE_TAG_PREFIXES` (optional, comma-separated) and every
  `tag_prefix` in the rules, so no tag a rule can match is ever unprotected.
  Adding, removing, or renaming a namespace tag (on create or PATCH) requires
  one of these:
  1. super-admin standing **from a session credential**
     (`assertSessionAuthenticated`, as in labels), or
  2. **steward delegation**: the subject holds, through an access rule (not a
     member row), the `manager` role for a `tag_prefix` that covers **every**
     added and removed namespace tag, plus `project.update` on the project
     itself. Example: `dep1-leads` can file projects into or out of
     `dep1/team2`, but not `dep2/...`. This is the self-service "department
     admin" from #456. A steward can only change grants inside the subtree they
     already govern.

  **070 shares this gate.** 070's tag-prefix repository rules add their
  `tag_prefix` values to the same `namespaceTagPrefixes` union, and a
  `project.provision` service account satisfies the authority
  (`mayChangeAll`) so IaC can file projects into namespaces. Whichever of 069
  and 070 lands first builds the gate under these names; the other extends it.

  Non-namespace tags stay freely editable by managers. PATCH keeps replacing
  the whole array: the gate compares only the namespace subset of
  `current.tags` and `input.tags`. A manager who sends back the namespace tags
  unchanged is not blocked.

  **CAS safety**: the gate is evaluated **inside** the `mutateObject` callback
  in `ProjectService.updateProject` against `current`, not in the route against
  a pre-read. Otherwise a manager's whole-array PATCH that races a super-admin
  namespace change could revert it. The route computes a pure
  `NamespaceTagAuthority` value
  (`{ prefixes, mayChangeAll: boolean, stewardPrefixes: string[] }`) and passes
  it in. The callback throws `ForbiddenError('Changing namespace tags requires
  super-admin standing or a manager access rule for the namespace')` when the
  diff isn't covered.

- **Audit**: when the namespace subset changes, `updateProject` and
  `createProject` commit their catalog entry with operation
  **`project.namespace_tags`** (instead of `project.update` /
  `project.create`). The context is
  `{ project_id, previous_namespace_tags: string[], next_namespace_tags: string[], authority: 'super-admin' | 'access-rule' }`,
  following `project.security_labels` (`ProjectService.ts:509–518`). Free-tag
  changes stay under `project.update`. These are durable catalog events that
  the project audit log (`GET /projects/{pid}/events`) already surfaces.
- **Migration caveat (docs)**: projects tagged before a rule exists start to
  inherit as soon as the rule deploys, and tags that managers set earlier
  become protected only from then on. Before enabling a rule, operators audit
  existing tags (066's `tag_prefix` list filter).

### Listing (and 071)

- Phase 1 needs **no listing change for correctness**. `entryRole` already
  loads `project.json` per non-owner entry, and `effectiveRole` sees the rules
  through `policy`.
- `resolveAccessRuleRole` accepts the snapshot form `{ id, tags? }` and returns
  `null` (indeterminate) only when a `tag_prefix` rule names one of the
  subject's groups and `tags` is absent. That gives 071 a snapshot-only
  candidate filter. **A caveat 071 must keep:** a rule match alone cannot prove
  visibility, because an explicit `app-user` row would cap the user below
  `viewer`. The snapshot carries no roles (`bucket_spec.md` §12: "a stale roster
  cannot prove that a restrictive membership is absent"). The safe fast path:
  if the subject is **not** in `member_ids`/`member_emails` **and** the roster is
  authoritative (071's concern), then the rule result decides. Otherwise load
  `project.json`. Do not implement that here.
- `listsAllProjects` (`AuthorizationService.ts:672–684`), `canSeeProjectEntry`
  (`authz.ts:222–237`), and the `isAppOnly` fallback (`ProjectService.ts:311`)
  read a new helper `subjectBaselineRole(subject, policy)` = max of
  `subjectDefaultRole` and `wildcardAccessRuleRole`. A
  `projects: "*" → viewer` rule therefore behaves like a group-scoped
  `MARIMOHUB_DEFAULT_ROLE=viewer`, matching how entitlement defaults behave
  today. `subjectDefaultRole` itself is **unchanged**, so
  `/capabilities.default_role` keeps meaning "deployment/entitlement fallback".

### Session deadlines

A role obtained through `access-rule` depends on group data, so a kernel
session admitted by it must not outlive the groups.
067 reuses `entitlementsExpiresAt` for groups and already changes
`entitlementAuthorizationDeadline` (`sessions.ts:644–656`) to guard on
`user.entitlements?.length || user.groups?.length`;
`sessionAuthorizationDeadline` (`mcp/sessionActivity.ts:12–27`) folds the same
expiry in. 069 adds no deadline code; it only adds the test below. If 067
shipped groups without that expiry bound, see STOP.

### Policy analyzer and introspection

- `AuthorizationStageSchema.subject.groups` (bounded by 067's `MAX_AUTH_GROUPS = 32`
  and `isAuthGroupId`) is added by 067; verify it exists. 069 only threads it into the synthetic subject and the `live-self` subject
  (`policyAnalyzer.ts:546–576`). A `live-self` subject uses the caller's real
  groups, and supplying `groups` there is rejected as
  `live_context_requires_self`.
- `SyntheticProjectSchema` gains `id: z.string().refine(ProjectId.is).optional()`
  and `tags: z.array(z.string()).max(64).default([])`. `syntheticProject`
  (386–400) uses them instead of `tags: []` and a fresh id.
- The role trace step (`AuthorizationService.ts:581–586`) adds
  `details.accessRules: [{ index, group, role, via }]` from
  `roleResolution.accessRuleMatches`, and `code` becomes
  `effective_role_access-rule` when the rule wins. When an explicit row caps a
  higher rule grant, it adds `details.accessRulesCappedByMembership: true`.
  That is the "why didn't my rule apply" answer.
- `PolicyAnalyzerMetadataSchema.capabilities` gains
  `access_rules: z.number().int().nonnegative()` (count only).
- `AdminPolicySchema` (`shared.ts:1513`) gains `access_rule_count` and
  `namespace_tag_prefixes: string[]`, set in `admin.ts:908–911`. The rules are
  not exposed to non-admins. `/capabilities` and `/me` get **nothing**: group
  ids are internal topology, and the per-project `your_role` already reflects
  the result.

### Phase 2 (separate PR, sketched only): `library` backend for a network PDP

The port is `packages/core/src/ports/accessGrants.ts`, exported as
`./ports/access-grants` and re-exported from `ports/index.ts`:

```ts
export const ACCESS_GRANTS_ADAPTER_API_VERSION = 1;
export const MAX_ACCESS_GRANTS = 256;
export const AccessGrantsSchema = z.strictObject({
	schemaVersion: z.literal(1),
	grants: z.array(z.strictObject({ projects: AccessRuleProjectsSchema, role: z.enum(ASSIGNABLE_ROLES) })).max(MAX_ACCESS_GRANTS),
	policyVersion: z.string().regex(SECURITY_LABEL_TOKEN),
	expiresAt: z.iso.datetime(),
});
export function validateAccessGrants(value: unknown, now?: Date): AccessGrants | null; // expired/malformed → null
export interface ProjectAccessGrantProvider {
	resolve(principal: AuthenticatedPrincipal, signal: AbortSignal): Promise<AccessGrants | null>;
}
export function isProjectAccessGrantProvider(value: unknown): value is ProjectAccessGrantProvider;
```

- The provider resolves **per principal, once per request**, into a bounded
  grant list. It never answers per project, which would make the sync
  `resolveEffectiveRole` async and add a network call to every list row.
  Grants are rules without `group`, already bound to this principal, and go
  through the same matcher.
- Resolution happens in the API auth middleware (`createApi.ts:497–513`, after
  `c.set('user', user)`). The grants are attached as
  `principal.accessGrants` (a new optional field on `AuthenticatedPrincipal`),
  with `withDeadline` (`core/src/async.ts`) at
  `MARIMOHUB_AUTHZ_ACCESS_RULES_TIMEOUT_SECONDS` (default 5, matching the
  subject-context deadline). An optional bounded cache keyed by credential id
  never outlives `expiresAt`. Sandbox proxy entrypoints that authenticate
  outside `/api/v1` need the same hook. Enumerate them before starting Phase 2.
- **Fail closed** means no grants: timeout, throw, or invalid result →
  `accessGrants = []`, and the user falls back to membership and defaults. The
  request still succeeds. Emit `authz_access_grants_timeout|failed|invalid`
  (content-free, like `SECURITY_EVENTS`). Session deadlines include
  `accessGrants.expiresAt`.
- Config: `MARIMOHUB_AUTHZ_ACCESS_RULES_BACKEND = env (default) | library | none`,
  `MARIMOHUB_AUTHZ_ACCESS_RULES_LIBRARY`, and
  `MARIMOHUB_AUTHZ_ACCESS_RULES_TIMEOUT_SECONDS`. `library.ts` adds a
  `'project-access-grants'` entry to `LIBRARY_CONFIG` (41–66) with
  `apiVersion: ACCESS_GRANTS_ADAPTER_API_VERSION`, widens the
  `loadMethodAdapter` kind union (382), adds `accessGrants?` to
  `LoadedAdapterLibraries` (33–38), and loads it in `loadAdapterLibraries`
  (469–497). Namespace-tag protection under `library` uses only
  `MARIMOHUB_AUTHZ_NAMESPACE_TAG_PREFIXES`, which becomes required when
  `library` is selected. Steward delegation uses `manager` grants.

Rejected:

- **Rules as a bucket CAS record** (e.g. `_system/access-rules.json` with an
  admin UI). This fits a later phase, and the matcher is storage-agnostic.
  v1 is env/IaC because enterprises want access policy reviewed in git, it
  needs no new single-writer owner in the CLAUDE.md invariant list, and it
  avoids a UI that becomes a super-admin escalation path.
- **Group member rows alone (068)**. One row per project does not scale to
  "every project under dep1". New projects get no inheritance unless a creator
  remembers to add the rows, and removing a department means editing N
  projects.
- **Nested projects / a parent-project entity**. This would rewrite the catalog
  snapshot, paths, CAS ownership, and list semantics. Tag paths give the
  hierarchy at a fraction of the cost (066).
- **Rules that override explicit membership**, or **strict precedence over
  defaults**. The first breaks plan 049's guarantee and the per-project
  carve-out. The second silently downgrades users under `DEFAULT_ROLE=editor`.
- **Option (c), unprotected namespace tags**. See above: it lets any project
  manager silently remove inherited oversight.
- **Matching rules on emails or user ids**. Member rows already do this; the
  feature is about IdP groups.
- **Case-insensitive group matching**. Group ids are opaque, and the existing
  group variables are exact.

## Steps

1. **Core rule model** (`packages/core/src/accessRules.ts` + `accessRules.test.ts`).
   Add the schema, `parseAccessRules`, `resolveAccessRuleRole`,
   `accessRuleRole`, `wildcardAccessRuleRole`, `namespaceTags`, and the
   `tagMatchesPrefix` fallback (or the 066 import). Add the package.json export
   `./access-rules` and the `index.ts` re-export. Tests: `admin` is rejected;
   unknown keys are rejected; >256 rules are rejected; an empty `projects`
   array is rejected; an invalid project id is rejected; a `tag_prefix` of
   `dep1/`, `Dep1`, or `dep1//x` is rejected; `dep1` matches `dep1` and `dep1/x` but not
   `dep10`; max rank wins; `groups` undefined → null; a legacy entry without
   tags → indeterminate only when a prefix rule names a subject group; `matches`
   come back in index order.
2. **Core authz** (`packages/core/src/authz.ts`): extend `AuthzPolicy` (63–69)
   and `EffectiveRoleSource` (71–79), and add `accessRuleMatches` to
   `EffectiveRoleResolution`. Rewrite lines 160–177 as the row-5 max-merge with
   the tie order above. Leave 135–158 untouched. Compute rule matches before
   the membership `return` (158) only to populate `accessRuleMatches` with a
   capped flag; the returned role stays the membership role. Add
   `subjectBaselineRole` and use it in `canSeeProjectEntry` (228). 071 deletes
   `canSeeProjectEntry`; if 071 has landed, skip that call site and instead
   pass `{ id, tags }` from the snapshot entry into 071's `projectEntryRole`
   so rules evaluate there (071 §1 notes the widened `Pick`). Add the
   `groups` field to `IdentitySubject` only if 067 hasn't (it should have).
   Tests in `authz.test.ts`:
   - explicit viewer row + manager rule → viewer, source `member-id`;
   - email-invite row + rule → row wins;
   - owner and super admin unaffected;
   - rule editor + `DEFAULT_ROLE=viewer` → editor `access-rule`;
   - rule viewer + `DEFAULT_ROLE=editor` → editor `deployment-default`;
   - rule viewer + `default-role:editor` entitlement → editor `entitlement-default`;
   - a tie → `access-rule`;
   - a rule never yields `admin`;
   - no groups → existing behavior byte-for-byte (snapshot the old cases).
3. **AuthorizationService** (`AuthorizationService.ts`): add rule evidence to
   the role trace (581–586), and make `listsAllProjects` (681) use
   `subjectBaselineRole`. Add `AuthorizationService.test.ts` cases for
   `project.read` and `project.update` allowed via a rule, `project.members.manage`
   for a rule manager, and a session-start under `viewerMode` for a rule viewer.
4. **ProjectService namespace gate** (`ProjectService.ts`): add an optional
   `namespace?: NamespaceTagAuthority` argument to `createProject` (337) and
   `updateProject` (399). The gate runs inside the `mutateObject` callback
   (412–426) and before writing in `createProject`. Commit catalog operation
   `project.namespace_tags` with the context above when the namespace subset
   changed. `isAppOnly` (311) uses `subjectBaselineRole`. The bootstrap caller
   (`services/index.ts:686`) passes nothing, so there is no gate (it creates
   the default project with no tags). Tests: a manager PATCH that preserves
   namespace tags succeeds; adding or removing one is a 403 `ForbiddenError`;
   a super-admin authority succeeds and emits `project.namespace_tags` with
   previous/next; a steward covering `dep1` may move `dep1/a → dep1/b` but not
   to `dep2/a`; a concurrent namespace change between the read and the CAS is
   still gated against `current`.
5. **API wiring** (`packages/api/src/routes/projects.ts`): in `createProject`
   (381–396) and `updateProject` (409–419), build the `NamespaceTagAuthority`
   from `deps.policy` and the user. `mayChangeAll` = `isSuperAdmin` **and**
   `c.get('authMethod')` is not `pat` (the inverse of `assertSessionAuthenticated`, `shared.ts:344–349`
   but non-throwing). `stewardPrefixes` = the `tag_prefix` values of
   rules with role `manager` matching `user.groups`. Add `PolicyConfig` fields
   `accessRules?` and `namespaceTagPrefixes?` (`context.ts:270–323`). Update the
   route description strings for `projects.create` and `projects.update` to
   mention namespace tags. In `projects.test.ts`: a PAT from a super admin
   cannot change namespace tags; a session can; a PATCH without tags is
   unaffected.
6. **Session deadlines**: confirm 067's guard in `sessions.ts:644–656` and
   `mcp/sessionActivity.ts:12–27` covers group-bearing principals. Add a test: a rule-admitted edit session
   gets `authorization_expires_at` ≤ the group expiry.
7. **Config** (`packages/config/src/accessRules.ts` + test). Add
   `accessRules(env)`: unset or blank → `undefined`, **no warning**; otherwise
   `JSON.parse` + `parseAccessRules`, and on failure throw `ConfigError`
   `MARIMOHUB_AUTHZ_ACCESS_RULES must be a JSON array of { projects, group, role } rules.`
   (include the zod issue path, never the value). Add
   `namespaceTagPrefixes(env, rules)`: the union of the env list and the rule
   prefixes, each validated with the same prefix schema. Rules require an
   auth setup that can populate `groups` per 067: `MARIMOHUB_AUTH_BACKEND=oidc`
   with either `MARIMOHUB_AUTH_OIDC_MEMBERSHIP_GROUPS` /
   `MARIMOHUB_AUTH_OIDC_MEMBERSHIP_GROUP_PREFIXES` (which themselves require
   `MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM`) or
   `MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND=library`. Otherwise it is a
   `ConfigError`, because rules that can never match are a misconfiguration.
   Warn when the max rule rank ≤ `parseDefaultRole(env)` (`index.ts:507`).
   Wire both into the `policy` block at `index.ts:776–794`. Add spec entries in
   the `Server / API` group after `MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_LIBRARY`
   (`spec.ts:1676`): `MARIMOHUB_AUTHZ_ACCESS_RULES` and
   `MARIMOHUB_AUTHZ_NAMESPACE_TAG_PREFIXES`, both `optIn: true`, with
   `example:` and **no `default:`** (the wizard emits literal defaults). Add a
   commented line to `apps/server/.env.example` near line 112. Tests: valid,
   malformed, an `admin` role, a non-oidc backend, a prefix union, and the
   warning.
8. **Policy analyzer** (`policyAnalyzer.ts`): the schema additions above, the
   metadata count, and `AdminPolicySchema` + `admin.ts:908–911`. Tests in
   `policyAnalyzer.test.ts`: a synthetic tagged project + groups → allowed with
   `effective_role_access-rule` and rule evidence; an explicit viewer row →
   capped flag; `live-self` with supplied groups → `live_context_requires_self`.
9. **Regenerate**: `pnpm schemas:generate` (openapi.yaml, client),
   `pnpm --filter @marimo-hub/config docs:generate` (`docs/configuration.md`),
   and `pnpm --filter @marimo-hub/docs exec vp test -u .vitepress/wizard` if the
   wizard snapshots change.
10. **Docs**:
    - `docs/auth.md`: a new `### Access rules` after "Default access for
      non-members" (166). Cover the rule syntax with the three-rule example, the
      ordering table, "explicit rows cap rules", "pair with
      `MARIMOHUB_DEFAULT_ROLE=none`", group-session lag
      (`MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS`), "PATs do not inherit",
      namespace tags and stewards, and the migration audit. Add one line to
      "Authorization roles" (66–93) pointing to it.
    - `docs/security.md` §Authorization (165): extend "Project reads require ...
      ownership, membership, or `MARIMOHUB_DEFAULT_ROLE`" (204) with access
      rules. Add a short "Namespace tags" paragraph after "Applying labels"
      (226) covering the session-only super-admin or steward gate and the
      `project.namespace_tags` audit event.
    - `development_docs/bucket_spec.md` §12 AuthZ bullets (~1376–1380): add the
      rule row and the max-merge. Note that namespace tags are gated in
      `ProjectService` CAS callbacks.
    - `development_docs/auth.md` Policy analyzer (274): groups and tags in
      cases.
11. **Final: review the diff and strip AI-slop comments.** Remove narration,
    restated code, and obvious doc blocks. Keep the comments that explain *why*:
    the max-merge-not-precedence rationale, the CAS-gate rationale, and the
    caveat that a snapshot-only rule match cannot prove visibility.

## Verification

- `pnpm --filter @marimo-hub/core test`
- `pnpm --filter @marimo-hub/config test`
- `pnpm --filter @marimo-hub/api test`
- `pnpm schemas:generate`, then `git status` shows only the expected spec/client
  diffs. Drift tests pass. oasdiff: additive only (new optional fields).
- Root: `pnpm check && pnpm typecheck && pnpm test`, then `pnpm build`.
- `grep -rn "@marimo-hub/\(auth\|storage\|compute\)-" packages/core/src packages/api/src`
  → no new hits. `package-dependencies.test.ts` passes in core and api.
- Manual (Keycloak dev realm with a `/groups` claim, 067 configured,
  `MARIMOHUB_DEFAULT_ROLE=none`, and
  `MARIMOHUB_AUTHZ_ACCESS_RULES='[{"projects":{"tag_prefix":"dep1"},"group":"dep1-leads","role":"manager"},{"projects":"*","group":"all-staff","role":"viewer"}]'`):
  - A `dep1-leads` user sees and manages a project tagged `dep1/team1`, and only
    views a project tagged `dep2`.
  - Adding that user as an explicit `viewer` row on the dep1 project caps them
    at viewer.
  - A non-steward project manager PATCHing tags to drop `dep1/team1` gets 403.
  - The steward moves the project to `dep1/team2`. The project events show
    `project.namespace_tags`.
  - Removing the user from `dep1-leads` in the IdP and waiting out the group
    session TTL removes access.
  - The analyzer shows the rule evidence.

## STOP conditions

- **067 has not landed**, or it delivers groups without a bounded expiry that
  session deadlines can use: STOP. Do not add a `groups` field ad hoc in this
  plan.
- **Any code path where an access rule overrides an explicit membership row,
  ownership, or yields `admin`**: STOP. Row 4 must return before rules are
  consulted for the role, and `ASSIGNABLE_ROLES` must stay the only rule role
  type.
- **Any code path where a rule *lowers* a role** that defaults or entitlements
  would have granted: STOP (max-merge is the design).
- **Any adapter import in `packages/core` or `packages/api`**, or a core
  function that reads env: STOP. Parsing belongs in `packages/config`.
- If the namespace gate cannot run inside the `mutateObject` callback (e.g.
  `updateProject` is refactored to a pre-read), STOP. A route-level-only check
  is racy.
- If a new tag write path exists by implementation time (e.g. 066 adds tag
  rename, 070 provisioning creates tagged projects, or an MCP tool updates
  projects), it must pass a `NamespaceTagAuthority`. If it can't, STOP and
  report.
- If making `listsAllProjects`/`directory.search` rule-aware changes directory
  search visibility beyond "same as a viewer default", STOP and report.

## Follow-ups (out of scope)

- Phase 2 `library` PDP backend (sketched above).
- Rules stored in the bucket with an admin UI (single-writer CAS owner, added
  to the CLAUDE.md invariant list).
- Cloudflare Worker wiring (`examples/cloudflare-worker/src/index.ts:208`) and
  cloudflare-access groups.
- 071: the snapshot-only rule fast path described under "Listing".
- An admin "who has access via rules" report per project (an inverse query
  over rules × IdP groups needs directory data from 070).
