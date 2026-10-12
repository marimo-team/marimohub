# Plan 068: IdP groups as project-member principals (`{ group, role }` rows)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 4f46aaa0..HEAD -- packages/core/src/schema.ts packages/core/src/identityMatch.ts packages/core/src/authz.ts packages/core/src/services/content packages/core/src/services/catalog/CatalogService.ts packages/core/src/services/authorization packages/core/src/notifications.ts packages/api/src/routes/projects.ts packages/api/src/routes/policyAnalyzer.ts packages/api/src/routes/users.ts packages/api/src/shared.ts packages/web/src/components/Project/ProjectMembersDialog.tsx packages/web/src/api/hooks.ts`
> Plan 067 must have landed, so most of these files will show changes. Re-read
> the "Current state" anchors against the live code before each step; when an
> anchor moved, follow the symbol (not the line). A semantic mismatch, such as
> member rows that no longer hold exactly one identifier, is a STOP condition.

> From GitHub issue marimo-team/marimohub#456: a large org that runs hundreds
> of projects wants membership that follows IdP teams. The 066–071 direction
> has no nested project entity. 067 puts a bounded set of IdP group ids on the
> authenticated subject. This plan lets a project manager grant a project role
> to one of those groups, in the same roster as user rows and email invites.

## Status

- **Priority**: P1 (the core primitive behind #456; 069/070 build on it)
- **Effort**: M
- **Risk**: MED (it changes authz matching and the persisted `project.json`
  member shape. Older replicas cannot parse a group row; see the rollout rule)
- **Depends on**: **067 (hard)**: `subject.groups?: readonly string[]` on the
  authenticated principal, bounded, `sso` credential kind only in v1. 066 is
  independent. 069 (config-driven access rules), 070 (provisioning), and 071
  (list scale) consume this plan's `member_groups` projection and row shape.
- **Category**: auth / access-control
- **Planned at**: commit `4f46aaa0`, 2026-10-07

## Current state

All anchors were verified at `4f46aaa0`.

### Persisted shapes (`packages/core/src/schema.ts`)

- `ProjectMemberSchema` (lines 393–401) is a plain `z.object` with
  `user_id?`, `email?` (lowercased), and `role: z.enum(ROLES)`. A `.refine`
  requires exactly one of `user_id | email`. `z.object` **strips unknown keys**.
  An older replica that parses `{ "group": "x", "role": "viewer" }` therefore
  sees `{ role }`, and the refine fails. `readStored`/`parseStored`
  (lines 100–117) then throw `StoredObjectError` (503 `SERVICE_UNAVAILABLE`).
- `ProjectSchema` (lines 424–447) holds `members: z.array(ProjectMemberSchema)`
  and `schema_version: SchemaVersionSchema`. `SchemaVersionSchema` (line 56)
  accepts any positive int. `CURRENT_PROJECT_VERSION = 1` (line 61). No
  project.json migration exists. `development_docs/migrations.md` says the
  fan-out runner is an unwired prototype.
- `SnapshotProjectEntrySchema` (lines 233–278) is a `z.looseObject`.
  `member_ids` is at line 254 and `member_emails` (lowercased) at line 260.
  An older replica keeps unknown keys such as a future `member_groups` when it
  round-trips the snapshot. `toPublicProjectEntry` is an explicit pick
  (comment at lines 300–305), so filtering aids never leak.
- `ROLES` / `ASSIGNABLE_ROLES` are at `packages/core/src/constants.ts` lines 54–59.
  `ASSIGNABLE_ROLES` excludes `admin`.

### Matching and authz

- `packages/core/src/identityMatch.ts`:
  - `IdentitySubject` (lines 12–16) is `{ id, email, entitlements? }`. 067 is
    expected to add `groups?`. Check this before Step 2.
  - `MemberRef` (lines 19–22) is `{ user_id?, email? }`.
  - `memberRefMatchesSubject` (lines 68–71) matches id rows exactly and email
    rows by `emailsEqual`. A row with neither identifier returns `false`
    (fail closed).
  - `memberRefMatchesSelector(member, selector: string)` (lines 78–81).
- `packages/core/src/authz.ts`:
  - `EffectiveRoleSource` union (lines 71–79).
  - `resolveEffectiveRole` (lines 130–178) checks entitlement super-admin, then
    static super-admin, then owner, then the max-rank loop over matching member
    rows. On equal rank it prefers an id row over an email row (lines 145–155).
    Then come the entitlement default and the deployment default.
  - `subjectDefaultRole` (lines 39–49).
  - `canSeeProjectEntry` (lines 222–237) returns `null` if `member_ids` is
    missing and treats a missing `member_emails` as empty (fail closed, as
    documented in lines 213–220).
- `packages/core/src/services/authorization/AuthorizationService.ts`:
  - `ProjectEntryVisibilityInput` (lines 286–291).
  - `analyze`/`decideBaseline` emits the trace code
    `effective_role_${roleResolution.source}` (lines 579–586).
  - `role()` (lines 651–653), `listsAllProjects` (lines 672–685), and
    `projectEntryVisibility` (lines 692–706).
  - **Fact:** `projectEntryVisibility` / `canSeeProjectEntry` have **no
    production callers**, only tests. `ProjectService.listProjects` (lines
    218–284) calls `entryRole` (lines 286–307) for every entry, and `entryRole`
    always loads `project.json`. The comment at lines 299–300 says "A roster
    projection can lag a committed membership change". The snapshot projection
    is therefore used today only by `CatalogService.hasProjectInvolvement` and
    the invite sweep.
- `packages/core/src/services/authorization/actions.ts` line 138:
  `'project.members.manage': project('manager', 'forbidden')`.

### Roster writes (`packages/core/src/services/content/ProjectService.ts`)

- `NewMember` (line 78) is `{ user_id; email? } | { email }`.
- `hasInviteRows` (lines 110–112), `selectorAfterClaims` (lines 122–126), and
  `resolveInviteRows` (lines 131–195). **Latent crash:** the loop handles
  `user_id` rows and treats every other row as an email row. It calls
  `normalizeEmail(member.email as string)` at line 173, which would throw on a
  group row whenever the same roster also contains an email row, because then
  `hasInviteRows` is true.
- `isAppOnly` (lines 309–327) goes through `entryRole` → `effectiveRole`, so it
  inherits the group matching with no change.
- `createProject` writes the snapshot entry with `member_emails: []` (line 386).
- `addMemberWithMutation` (lines 567–595) runs the duplicate check and returns
  409 `ConflictError`.
- `updateMemberRoleWithMutation` (lines 611–639) and `removeMemberWithMutation`
  (lines 649–671) take `selector: string`. The owner guard is
  `selector === current.owner`.
- `writeMembers` (lines 678–688) does `mutateMemberObject` (project.json ETag
  CAS, lines 690–718), then `catalog.updateProjectEntry('project.members', …)`.
  `updateProjectEntry` (`CatalogService.ts` lines 317–335) delegates to
  `mutateSnapshot`, which satisfies the key invariant.
- `claimProjectInvites` (lines 720–751) checks projection freshness with
  `sameValues` on `member_ids` / `member_emails` (lines 737–739).
  `claimPendingInvites` (lines 753–768) only selects entries that have
  `member_emails`.
- `packages/core/src/services/content/catalogProjection.ts`
  `projectCatalogPatch` (lines 79–98) builds `member_ids` / `member_emails`.
- `packages/core/src/services/catalog/CatalogService.ts`
  `hasProjectInvolvement(user: { id; email })` (lines 124–182) builds the
  candidate index from `member_ids` / `member_emails`, with a legacy fallback
  at lines 150–153. It then confirms with `memberRefMatchesSubject`. The only
  caller is `packages/api/src/routes/users.ts` `authorizeDirectory`
  (lines 103–115), which gates directory search.

### Notifications / alerts (`packages/core/src/notifications.ts`)

- The data schemas are at lines 49–80. `MemberAddedDataSchema` requires
  `member_user_id`. `MemberRoleChangedDataSchema` and `MemberRemovedDataSchema`
  carry nullable `member_user_id` / `member_email`.
- `memberLabel` (lines 256–258), `memberData` (lines 260–265), and the
  `member.role_changed` (line 485) and `member.removed` (line 506) renderers.
- `GLOBAL_NOTIFICATION_KINDS` (lines 654–658) and `PROJECT_ALERT_KINDS`
  (lines 660–673).
- `resolveMemberRecipient` (lines 763–772).
- Catalog audit events record only the op name (`project.members`) and
  `project_id`, not the member (bucket_spec.md line 621). No audit change is
  needed.

### API (`packages/api/src/routes/projects.ts`)

- `AddMemberBody` (lines 89–97) takes exactly one of `user_id | email`.
  `UpdateMemberRoleBody` is at lines 99–101.
- `MemberIdParam` (lines 103–115): `uid` is the user id or a URL-encoded invite
  email.
- `visibleMembers` (lines 125–133) shows non-managers the id rows plus their
  own invite row.
- The routes are `listMembers` (287–305), `addMember` (307–325),
  `updateMember` (327–342), and `removeMember` (344–355).
- The handlers are list (493–500), add (502–571), update (573–598), and
  remove (600–619).
- `ProjectMemberResponseSchema` is at `packages/api/src/shared.ts`
  lines 1060–1066.
- `packages/api/src/routes/policyAnalyzer.ts`:
  - `SyntheticMemberSchema` (lines 71–79).
  - Authorization stage `subject` (lines 133–139).
  - `syntheticProject` → `ProjectSchema.parse` (lines 383–398).
  - Subject construction (lines 547–575). Live-self spreads `caller`.
- The CLI is generated from OpenAPI into `apps/cli/generated/cli-manifest.json`
  (`projects.members.*` entries near lines 4678–4800).
  `pnpm schemas:generate` regenerates it.
- A precedent for slash-bearing identifiers is the `?path=` query param on
  `GET /projects/{pid}/notebooks/{nid}/workspace/files` (`notebooks.ts`
  lines 828–845).
- The test pattern for a custom principal is the inline `authenticator` in
  `packages/api/src/routes/projects.test.ts` lines 440–455.

### Group ids in auth-oidc (for bounds only; never import it from core/api)

- In `packages/auth-oidc/src/claims.ts`, `MAX_GROUPS = 200` (line 27) and
  `MAX_GROUP_LENGTH = 256` (line 28).
- `validGroup` (lines 111–118) requires a non-empty string of at most 256
  chars with no control characters.
- Group ids are compared **exactly** (case-sensitive). They can contain `/`
  (Keycloak paths), spaces (Okta names), or GUIDs (Entra).

### Web

- `packages/web/src/components/Project/ProjectMembersDialog.tsx`:
  - `memberKey` (lines 48–50) returns `user_id ?? email ?? ''`. A group row
    would get `''`, which causes key collisions.
  - `isCurrentUser` (lines 52–57).
  - `MemberChoice` (line 157).
  - `AddMemberPicker` (lines 185–311) is a `ComboBox` with directory hits, an
    `email:` invite action option (lines 224–238), and a raw-id option.
  - The roster rows are at lines 460–530 (the "Invited" badge is at
    lines 483–491).
- `packages/web/src/api/hooks.ts` member hooks are at lines 601–659
  (`useAddMember`, `useUpdateMemberRole`, `useRemoveMember`, and `memberKeys`).
- `packages/web/src/components/Project/ProjectAlertsDialog.tsx` `LABELS`
  (lines 16–29) is a `Record<ProjectAlertKind, string>`, so a new kind is a
  type error until it is labeled. `GROUPS` is at lines 42–50.
- `packages/web/src/components/Admin/AdminPolicyAnalyzerPage.tsx` lines 139–141
  render any `effective_role_*` code generically, so `member-group` shows as
  "member group" with no change.

### Docs

- `docs/auth.md` "Members: user ids and email invites" is at lines 95–128,
  with the rollout note at lines 125–128. The Manager rollout rule is at
  lines 186–190.
- `development_docs/bucket_spec.md`:
  - §4.3 project.json example at lines 348–370.
  - §12 projection text at lines 1389–1391.
  - Role assignability at lines 1405–1407.
- `docs/security.md` "Authorization (roles)" starts at line 165.
- `docs/project-alerts.md` kinds table is at lines 54–57.
- `docs/notifications.md` data-field table is at lines 148–152.

## Design

**A member row may name an IdP group: `{ group: "<idp group id>", role }`. A
caller matches it when `group ∈ subject.groups`. Group rows join the same
max-rank resolution as id and email rows. They never produce `admin`, they are
never claimed, and only managers write them.**

### Row shape and roles

- `ProjectMemberSchema` gains `group: MemberGroupSchema.optional()`. Keep the
  refine as **exactly one of** `user_id | email | group`. Add a second refine:
  a group row's role must be in `ASSIGNABLE_ROLES`, so `admin` is rejected.
- `MemberGroupSchema` is new in `schema.ts` and exported as
  `z.string().refine(isAuthGroupId)`, where `isAuthGroupId` /
  `AUTH_GROUP_ID_PATTERN` come from 067 (`packages/core/src/ports/auth.ts`:
  1–128 chars, no control characters, no commas, no leading or trailing
  whitespace). Do **not** define a second grammar and do **not** lowercase or
  trim: IdP group ids are exact, and a silent fold could alias two groups. A
  row that fails `isAuthGroupId` can never match a session group, so rejecting
  it at write time is the fail-closed choice.
- **`manager` is allowed** on a group row, the same as for users: "the
  platform team manages every project in this namespace" is the main #456 use
  case. **`admin` is never allowed.** Admin stays reserved for the owner, super
  admins, and grandfathered user rows. There are three layers of enforcement:
  1. The API accepts only `AssignableRoleSchema`.
  2. The schema refine rejects stored admin group rows (fail closed: the
     project then reads as 503, not as admin).
  3. `resolveEffectiveRole` skips a group row whose role is `admin`, in case a
     project object is built in memory and never parsed.
- Group rows are never converted by the invite claim. They have no identity
  to resolve.

### Matching and precedence

The resolution order is unchanged except for one new source:

1. Entitlement super-admin, then static super-admin, then owner. These are
   all `admin` and beat everything.
2. Explicit membership: the **max rank across every matching row**: id, email,
   and group. On equal rank the source preference is **id > email > group**.
   This only changes the reported `source`, never the role.
3. Entitlement default, then deployment default. These apply only when no row
   matches.

So a group row at `viewer` **caps** a user who would otherwise get an `editor`
default. This matches today's rule that explicit membership beats defaults
(bucket_spec §12 line 1380). Document it in docs/auth.md because it surprises
people. `EffectiveRoleSource` gains `'member-group'`, and the trace code
becomes `effective_role_member-group`.

`subject.groups` undefined or empty means group rows never match. Under
067 v1 that covers PATs, service accounts, and dev bypass; `sso` sessions and
external access tokens (which go through the same OIDC admission) do carry
groups. A user whose only grant is a group row has no access through a PAT,
the same as OIDC group-derived super-admin today (bucket_spec line 1397).
Document this. Removing a user from an IdP group takes effect when their
session refreshes. 067 owns that lag and its TTL knob.

### Snapshot projection

- `SnapshotProjectEntrySchema` gains `member_groups: z.array(z.string()).optional()`
  with no transform. `projectCatalogPatch`, `createProject` (`member_groups: []`),
  and the claim-sweep freshness check all maintain it inside the existing
  `writeMembers` → `updateProjectEntry` → `mutateSnapshot` path. No new
  CAS record and no new writer.
- `canSeeProjectEntry` / `ProjectEntryVisibilityInput` accept
  `member_groups?` and return visible on `member_groups ∩ subject.groups ≠ ∅`.
  A missing `member_groups` counts as empty (fail closed, same reasoning as
  `member_emails`). This creates no listing regression: listing reads
  `project.json` per entry. The projection exists for directory involvement and
  for 071.
- **071 interaction.** 071 adds a role-bearing `members` copy to the snapshot
  entry (fenced by `members_pending`) and deletes `canSeeProjectEntry` /
  `projectEntryVisibility` as dead code. If 071 has landed first, skip the
  `canSeeProjectEntry` change above; group rows ride inside 071's `members`
  verbatim, and 071's cross-check must compare `member_groups` against the
  group rows as well as ids and emails. `member_groups` stays as the
  involvement-index and `member=me` filter aid.
- `hasProjectInvolvement` indexes `member_groups` too. **Decision:** a group
  grant counts as project involvement for `GET /users/search`. A
  group-granted manager needs the add-member picker as much as a user-row
  manager does.

### No `schema_version` bump

The change is additive: existing rows are unchanged and nothing has to be
rewritten, so a fan-out migration would do nothing. Bumping
`CURRENT_PROJECT_VERSION` would not help either, because older readers already
accept any version and fail on the member refine. Follow the Manager and
email-invite precedent instead: an **operational rollout rule**.

> Stop all old replicas before the first group row is stored. Older versions
> cannot parse a `project.json` with a group row. On an old replica that one
> project returns 503, and so does **every project listing** for non-super-admin
> callers: `listProjects` loads every `project.json` through `entryRole` and
> rethrows `StoredObjectError`. Directory search fails too. Rolling back across
> this release requires removing all group rows first.

### API surface (oasdiff-safe: only additive changes)

| Operation | Shape |
| --- | --- |
| Add | `POST /projects/{pid}/members` with body `{ group, role }`. `AddMemberBody` gains `group` (an optional request property, which is non-breaking) and the refine becomes exactly one of three. 409 on a duplicate group. |
| Change role | **new** `PUT /projects/{pid}/group-members?group=<id>` with body `{ role }`. operationId `projects.members.groups.update`. 404 if no such row. |
| Remove | **new** `DELETE /projects/{pid}/group-members?group=<id>`. operationId `projects.members.groups.remove`. 404 if no such row. |
| List / detail | Group rows appear in `ProjectMemberResponseSchema` as `group` (an added response property). They are visible to **every** caller who can see the project. Group ids are not personal data, and members need them to see who has access. |

The group is addressed by **query param on a distinct path**, not by `uid`,
for three reasons:

- (a) `uid` is an opaque IdP `sub`, so a `group:<id>` prefix could collide with
  a real user id. The owner guard `selector === current.owner` would then
  compare across namespaces. This is the same hazard `refMatchesSubject`
  documents for emails.
- (b) Group ids can contain `/`. An encoded `%2F` in a path segment is
  normalized by proxies such as Cloudflare and nginx. The
  `workspace/files?path=` route sets the precedent.
- (c) `/members/groups/{g}` would share a prefix with `/members/{uid}` when the
  uid is `groups`.

Adding a group the caller is **not** in is allowed: a manager grants a team.
The CLI picks up `projects members groups update|remove` and
`projects members add --group` through regeneration. MCP has no member tools,
so it is out of scope.

**Gating on a group source (align with 067):** 067 carries groups only when
`MARIMOHUB_AUTH_OIDC_MEMBERSHIP_GROUPS` / `..._MEMBERSHIP_GROUP_PREFIXES` are
set or a login-policy module returns `groups`. Expose that as a boolean
`groups_carried` on `PolicyConfig` (set in `packages/config/src/index.ts`'s
`policy` block) and reject a group add with 422 `ValidationError('This
deployment does not carry identity-provider groups')` when it is false: a
group row could never match and would mislead managers. Do **not** validate
the add against the membership allowlist or prefixes: a login-policy module
selects groups by code, so the env filter is not a complete predicate.

### Notifications

- A new broadcast-only kind `member.group_added` (severity `info`) with data
  `{ project_id, project_name, role, member_group, actor_user_id }`. Append it
  to `PROJECT_ALERT_KINDS` **only**. It has no personal recipient, so it is not
  in `GLOBAL_NOTIFICATION_KINDS` and `MARIMOHUB_NOTIFY_KINDS` validation is
  unaffected.
- `MemberRoleChangedDataSchema` and `MemberRemovedDataSchema` gain
  `member_group: z.string().nullable()`. This is additive to webhook payload
  v1.
- `memberData` emits `member_group: member.group ?? null`, and `memberLabel`
  renders `group <id>`.

### Invariants to protect

1. A group row never yields `admin`.
2. The owner can never be removed or demoted. Group selectors are a separate
   type and never reach the owner string comparison.
3. Only `project.members.manage` (manager+) writes group rows.
4. `project.json` is written only by `ProjectService.mutateMemberObject` (CAS).
   Snapshot writes go only through `updateProjectEntry` → `mutateSnapshot`.
5. A string selector (`/members/{uid}`) never matches a group row, and a group
   selector never matches a user or email row.

## Rejected

- **Syncing IdP group members into user rows at login.** Plan 049 rejected
  this already: it puts writes on the login path, fights the invite/claim
  model, and duplicates state the IdP owns. Matching at request time against
  `subject.groups` needs no stored copy.
- **A first-class groups entity or directory** (`_system/groups/{id}.json` with
  enumerated members). The hub cannot enumerate IdP membership without SCIM
  (070's territory). It would add a new CAS owner and a staleness problem. A
  row that names an opaque IdP id is enough.
- **Per-notebook group grants.** There are no per-notebook ACLs today
  (bucket_spec line 1543). Group rows inherit the project-level model.
- **Addressing group rows via `uid` = `group:<id>`.** Rejected because of the
  namespace collision with opaque `sub`s and the encoded-slash problem (see
  Design).
- **Folding group ids to lowercase.** IdPs treat ids as exact strings, and
  folding could alias two distinct groups into one grant.
- **Making old replicas tolerate unknown identifiers** (an inert "unknown"
  row). This cannot be retrofitted. Worse, an old replica that rewrites the
  roster would persist a row stripped to `{ role }` and lose the grant. The
  503 failure is the safer outcome.
- **Reusing `member.added` for group adds.** Its data contract requires a
  non-null `member_user_id`. Loosening it would break existing webhook
  consumers.

## Steps

1. **Confirm the 067 seam.** Open `packages/core/src/ports/auth.ts`
   (`AuthUser`, lines 24–40 at `4f46aaa0`) and
   `packages/core/src/identityMatch.ts`.
   - Confirm `groups?: readonly string[]` exists on `AuthUser` and on
     `IdentitySubject`. If it is only on `AuthUser`, add it to
     `IdentitySubject` (lines 12–16).
   - Note whether 067 exported a group-token schema, a bound constant, or a
     deployment groups flag. Steps 2 and 5 use them.
   - Grep for principals rebuilt without groups:
     `rg -n "authorize\(|effectiveRole\(|resolveEffectiveRole\(" packages/api/src packages/core/src -g '!*.test.ts'`.
     Check that each call site passes the request principal (`c.get('user')`)
     and not a subject rebuilt from `identities.get`. A rebuilt subject would
     silently drop group grants. List any such sites in the PR. Fix them only
     if they are in this plan's files; otherwise see STOP.

2. **Core schema** (`packages/core/src/schema.ts`):
   - Add an exported `MemberGroupSchema = z.string().refine(isAuthGroupId)`
     after `EmailAddressSchema` (line 372), importing `isAuthGroupId` from
     `./ports/auth` (067).
   - `ProjectMemberSchema` (lines 393–401): add `group`, make the refine
     exactly one of three (message
     `'a member has exactly one of user_id, email, or group'`), and add the
     refine
     `m.group === undefined || (ASSIGNABLE_ROLES as readonly string[]).includes(m.role)`
     (message `'a group member cannot hold admin'`). Update the comment at
     lines 387–392.
   - `SnapshotProjectEntrySchema`: add `member_groups` after `member_emails`
     (line 260), with a comment saying it is exact (no fold) and that a missing
     value counts as empty (fail closed).
   - Tests in `packages/core/src/schema.test.ts`: a group row parses; two
     identifiers are rejected; zero identifiers are rejected; a group with
     admin is rejected; manager is accepted; control chars, commas, empty,
     129 chars, and padded whitespace are rejected; case is preserved.

3. **Identity matching** (`packages/core/src/identityMatch.ts`):
   - `MemberRef` gains `group?: string`.
   - Add `export type MemberSelector = string | { group: string };`.
   - `memberRefMatchesSubject`: after the `user_id` branch, add
     `if (member.group !== undefined) return subject.groups?.includes(member.group) ?? false;`.
   - `memberRefMatchesSelector(member, selector: MemberSelector)`: an object
     selector matches only `member.group === selector.group`. A string
     selector never matches a group row (add `if (member.group !== undefined) return false;`).
   - Update the module doc comment. Add tests to `identityMatch.test.ts`
     (exact match, case-sensitive, undefined groups, cross-namespace
     non-match).

4. **Authz** (`packages/core/src/authz.ts`):
   - Add `'member-group'` to `EffectiveRoleSource`.
   - In `resolveEffectiveRole` (lines 140–158), replace the id-vs-email
     tie-break with a source preference map
     `{ 'member-id': 2, 'member-email': 1, 'member-group': 0 }`. Replace `best`
     when the rank is higher, or when the rank is equal and the preference is
     higher. Skip `member.group !== undefined && member.role === 'admin'`. Keep
     the `admin` early break.
   - `canSeeProjectEntry` (lines 222–237): widen the entry type with
     `member_groups?: string[]` and add the intersection check after the email
     check.
   - Update the module and function doc comments (lines 13–17, 107–120,
     202–221).
   - Tests in `authz.test.ts` (`effectiveRole` describe at line 50,
     `canSeeProjectEntry` at line 307, app-user at line 384):
     - The group row grants its role.
     - Max rank across id + group, and across two groups.
     - Equal rank reports source id over email over group.
     - A group row at viewer beats an editor deployment default and an editor
       entitlement default.
     - Owner and super-admin beat group manager.
     - An in-memory admin group row is ignored.
     - Undefined groups → no match.
     - Entry visibility via `member_groups`; missing `member_groups` → not
       visible (not `null`).

5. **AuthorizationService**
   (`packages/core/src/services/authorization/AuthorizationService.ts`):
   - Add `member_groups?: string[]` to `ProjectEntryVisibilityInput`
     (lines 286–291).
   - Nothing else changes: `role()`, `analyze`, and session admission all go
     through `resolveEffectiveRole`. `listsAllProjects` stays defaults- and
     super-admin-based. A group row is explicit membership, not a deployment
     default.
   - Add one `AuthorizationService.test.ts` case: `project.members.manage` is
     allowed for a group-derived manager, and the trace contains
     `effective_role_member-group`.

6. **ProjectService and projections**
   (`packages/core/src/services/content/ProjectService.ts`,
   `catalogProjection.ts`, `CatalogService.ts`):
   - `NewMember` (line 78): add `| { group: string }`.
   - `resolveInviteRows` (lines 160–192): at the top of the loop, add
     `if (member.group !== undefined) { output.push(member); continue; }`.
     This fixes the latent crash.
   - `selectorAfterClaims` (lines 122–126) returns `MemberSelector`. A group
     row returns `{ group: member.group }`.
   - `addMemberWithMutation` (lines 567–595): for a group member, the
     duplicate check is `m.group === group`. Throw
     `ConflictError(\`group ${group} is already a member of project ${id}\`)`
     and build the row `{ group, role }`.
   - `updateMemberRoleWithMutation` / `removeMemberWithMutation`: take
     `selector: MemberSelector`. Apply the owner guard only when
     `typeof selector === 'string'`. The 404 message uses the group id for
     object selectors. `updateMemberRole` / `removeMember` wrappers widen the
     same way.
   - `createProject` (line 386): add `member_groups: []`.
   - `projectCatalogPatch` (`catalogProjection.ts` lines 79–98): add
     `member_groups`.
   - `claimProjectInvites` (lines 737–739): add
     `sameValues(candidate.member_groups, projection.member_groups)`.
     `claimPendingInvites` is unchanged: its candidates are still
     email-driven.
   - `CatalogService.hasProjectInvolvement` (lines 124–182): widen the param to
     `{ id; email; groups?: readonly string[] }`. Add a `groups` index map fed
     from `member_groups` and from the legacy loop (lines 150–153). Union the
     candidates from `user.groups`. The final confirmation already uses
     `memberRefMatchesSubject`.
   - Tests in `ProjectService.test.ts` (`membership` describe at line 388):
     - Add a group row, then a duplicate → 409.
     - Update and remove by `{ group }`.
     - The string selector equal to the group id → 404.
     - A roster with an email row plus a group row runs a claim without
       throwing and keeps the group row.
     - The projection carries `member_groups` after every write.
     - `isAppOnly` is false for a group viewer.
     - `listProjects` (`DEFAULT_ROLE=none` describe at line 134) shows a
       group-granted project only to group members.
   - Add a `CatalogService` test that group involvement returns true.

7. **Notifications** (`packages/core/src/notifications.ts`):
   - Add `MemberGroupAddedDataSchema`, the registry entry
     `'member.group_added'` (broadcast only, `info`), and a
     `MemberGroupAddedNotificationInput`
     `{ project, member: ProjectMember & { group: string }, actor, mutationId, baseUrl }`.
   - Add `member_group` to the role-changed and removed data schemas.
   - Update `memberData` and `memberLabel`.
   - Append the kind to `PROJECT_ALERT_KINDS` (lines 660–673).
   - `resolveMemberRecipient` (lines 763–772) returns `null` for group rows.
   - Update `packages/core/src/notifications.test.ts`.
   - Run `pnpm --filter @marimo-hub/core test`. It must pass.

8. **API routes** (`packages/api/src/routes/projects.ts`, `shared.ts`):
   - `ProjectMemberResponseSchema` (`shared.ts` lines 1060–1066): add
     `group: z.string().optional()` and update the comment to "exactly one
     of three".
   - `AddMemberBody` (lines 89–97): add
     `group: MemberGroupSchema.optional().openapi({ example: 'data-science' })`.
     The refine becomes exactly one of three, with the message
     `'Provide exactly one of user_id, email, or group'`.
   - Add a new `GroupMemberQuery = ProjectIdParam`-adjacent query schema:
     `z.object({ group: MemberGroupSchema.openapi({ param: { name: 'group', in: 'query', description: 'The exact identity-provider group id' } }) })`.
   - Add the new routes `updateGroupMember` (PUT) and `removeGroupMember`
     (DELETE) on `/projects/{pid}/group-members` with `request.query`. Their
     responses mirror `updateMember` / `removeMember`, including 409 and 429.
   - `listMembers` description (lines 293–295): say that group rows are
     visible to all.
   - `visibleMembers` (lines 125–133): keep
     `m.user_id !== undefined || m.group !== undefined || m.email === email`.
     Update the comment.
   - Add handler (lines 502–571): branch first on `body.group !== undefined`.
     The branch skips identity lookups, calls
     `assertNotificationMutationAllowed(deps, user.id, { delivery: 'project-alert' })`,
     then `projects.addMemberWithMutation(pid, { group: body.group }, body.role, user.id)`,
     then `scheduleProjectAlert(deps, pid, 'member.group_added', …)`. It
     returns 201 with `projectResponse`. Apply the 067 gating rule from
     Design here.
   - The group update and remove handlers mirror lines 573–619 with selector
     `{ group }`.
   - `users.ts`: no code change. `authorizeDirectory` passes the full principal
     to `hasProjectInvolvement`. Add a test in `users.test.ts` that a
     group-only member may search.
   - Tests in `projects.test.ts` (`Project member routes` describe at
     line 415). Use the inline-authenticator pattern from lines 440–455 with
     `credential: { kind: 'sso' }, groups: ['team-a']`:
     - A group member reads the project; a non-member gets 404.
     - A group manager adds, updates, and removes a user.
     - Group rows are listed for a viewer.
     - `uid` = group id → 404.
     - `role: 'admin'` → 422.
     - Exactly-one-of violations → 422.
     - A `/` in the group id round-trips via the query param.
     - A PAT principal for the same user (no groups) → 404.
     - Owner rows are unaffected.

9. **Policy analyzer** (`packages/api/src/routes/policyAnalyzer.ts`):
   - `SyntheticMemberSchema` (lines 71–79): add `group` and make the refine
     exactly one of three.
   - The authorization stage `subject` (lines 133–139) gains
     `groups` is added by 067 (bounded by `MAX_AUTH_GROUPS = 32` and
     `isAuthGroupId`); verify it exists rather than adding it again.
   - Explicit mode: set `groups` on the constructed subject (lines 547–558).
   - Live-self keeps `caller.groups` through the spread. Do not override it
     from the body: live-self is the real caller.
   - Login-linked mode: 067 extends the login evaluation to return `groups`;
     use them.
   - Tests in `policyAnalyzer.test.ts`: a synthetic group row allows with
     `effective_role_member-group`; a group admin row → 422 from
     `ProjectSchema.parse` (map to the existing invalid-input path).

10. **Specs and generated artifacts.** Run `pnpm schemas:generate`. This
    regenerates `packages/api/openapi.yaml`, `apps/cli/generated/cli-manifest.json`,
    `internal/schemas/bucket.yml` (Project members `group`, snapshot
    `member_groups`, alerts kind enum), and `packages/client/src/schema.ts`.
    Inspect the diffs: they must contain only additions. If the oasdiff gate
    reports an ERR-level finding, see STOP.

11. **Web** (`packages/web/src`):
    - `api/hooks.ts` (lines 620–659):
      - Widen the `useAddMember` body with `group?: string`.
      - Add `useUpdateGroupMemberRole(projectId)` (PUT
        `/api/v1/projects/{pid}/group-members` with `params.query.group`) and
        `useRemoveGroupMember(projectId)`.
      - Both invalidate `memberKeys(projectId)`.
    - `components/Project/ProjectMembersDialog.tsx`:
      - `memberKey` returns `user_id ?? (group ? \`group:${group}\` : email) ?? ''`.
        This value is a React key only and is never sent to `/members/{uid}`.
      - `MemberChoice` gains `{ group: string }`. `isMember` checks
        `m.group === choice.group`.
      - In `AddMemberPicker`, when the trimmed query is non-empty and is not
        already a group row, append a final action option
        `id: \`group:${trimmed}\``,
        `action: \`Grant to identity-provider group "${trimmed}"\``.
        067 adds a required `groups` array to `GET /me`; offer the caller's own
        groups as suggestions. Gate the group option on the `/me` `groups`
        field being non-empty or on a `groups_carried` capability if one is
        exposed.
      - Update the helper text: the hub cannot list IdP groups, so paste the
        exact group id.
      - Roster rows: a group row renders a `Users` lucide icon, the group id
        (`translate="no"`, `truncate`), and a "Group" badge that matches the
        "Invited" badge style, with the tooltip "Everyone in this
        identity-provider group gets this role".
      - Role change and remove for group rows call the new hooks.
      - The toast says "Group added".
      - `RoleSelect` already excludes admin.
      - Any new text input uses the `TextField` primitive, which sets
        `validationBehavior="aria"` (see memory: native validation blocks
        later submits).
    - `components/Project/ProjectAlertsDialog.tsx`: add
      `'member.group_added': 'Group added'` to `LABELS` and add it to the
      `Access` group.
    - Tests in `ProjectMembersDialog.test.tsx`:
      - A group row renders with its badge and visible role.
      - A manager adds a group through the action option (asserts the POST
        body `{ group, role }`).
      - Role change and remove hit `/group-members?group=`.
      - Group ids containing `/` are encoded in the query.
      - A group option is not offered for an existing group.
    - Run `pnpm --filter @marimo-hub/web test`.

12. **Docs**:
    - `docs/auth.md` §"Members" (lines 95–128): rename it to "Members: user
      ids, email invites, and groups". Add a paragraph covering:
      - The exact group id from the IdP's groups claim (link
        `./setup/auth/oidc.md#groups-and-roles`).
      - Manager is allowed and admin is not.
      - Max rank across all rows; a group row caps defaults.
      - Group rows are visible to all project readers.
      - No PAT/service-account effect in v1.
      - The session-refresh lag.

      Add the rollout rule from Design next to the existing note at
      lines 125–128.
    - `development_docs/bucket_spec.md`:
      - §4.3 example (lines 356–359): add `{ "group": "data-science", "role": "editor" }`.
      - §4.3 Member roles note: say group rows cannot be admin.
      - §12 (lines 1380, 1389–1391): mention group rows in the max-rank rule
        and `member_groups` in the projection sentence.
    - `docs/security.md` "Authorization (roles)" (line 165+): add a short
      paragraph. Group grants come only from the verified IdP subject (067),
      never from request input; they cannot reach admin; Entra group overage
      or a missing claim fails closed (loss of access, never gain).
    - `docs/project-alerts.md` (lines 54–57): add a `member.group_added` row.
    - `docs/notifications.md` (lines 148–152): no change. Group events are not
      global kinds. Check this.

13. **Gates**: run root `pnpm check && pnpm typecheck && pnpm test`, then
    `pnpm build`.

14. **Review the diff and strip AI-slop comments**: remove restatements,
    change narration, and obvious-from-signature doc blocks. Keep only *why*
    comments, such as the no-fold rationale, the fail-closed missing
    projection, and the reason for the query-param addressing.

## Verification

- `pnpm --filter @marimo-hub/core test`: schema, identityMatch, authz,
  AuthorizationService, ProjectService, CatalogService, and notifications
  suites pass.
- `pnpm --filter @marimo-hub/api test`: projects, users, policyAnalyzer,
  projectAlerts, and the openapi/CLI drift specs pass.
- `pnpm --filter @marimo-hub/web test`: ProjectMembersDialog and
  ProjectAlertsDialog pass.
- `pnpm schemas:generate` followed by `git diff --stat` shows only additive
  changes in `openapi.yaml`, `bucket.yml`, `cli-manifest.json`, and
  `client/src/schema.ts`. A second run produces no diff.
- Root `pnpm check && pnpm typecheck && pnpm test && pnpm build`: exit 0.
- Manual test (Keycloak or Dex dev realm, with 067 configured to carry groups):
  1. User A is in group `team-a`, with `MARIMOHUB_DEFAULT_ROLE=none`.
  2. The owner adds `{ group: 'team-a', role: 'editor' }`.
  3. A sees the project in the list and can edit.
  4. Remove A from `team-a` in the IdP and refresh the session: A gets 404.
  5. A's PAT never sees the project.
  6. A group-manager can add a user but cannot assign admin (422) and cannot
     remove the owner (409).

## STOP conditions

- **067 has not landed**, or `groups` is not on the request principal that
  route handlers receive. Do not add group matching against any other source,
  such as raw claims or headers.
- **Any code path could let a group row yield `admin`**, or could let a group
  selector reach the owner guard as a string.
- Step 1's grep finds authorization call sites outside this plan's files that
  rebuild the subject without `groups`, where group-only members would be
  silently denied. This affects the kernel/session proxy, MCP, and jobs. Report
  the list; do not widen scope.
- `pnpm schemas:generate` produces an oasdiff ERR-level breaking finding.
  The design is meant to be purely additive, so re-check the change; do not
  add an `allowed-breaking` line.
- The fix seems to require a new mutable object, a second writer for
  `project.json`, or a snapshot write outside `mutateSnapshot`.
- `isAuthGroupId` from 067 is missing or has a different bound than 1–128
  chars. STOP: this plan must not define a second group grammar.

## Follow-ups (out of scope)

- Group grants for PAT and service-account principals. This needs 067 to
  carry groups on those credentials, for example by snapshotting them on the
  token grant.
- Cloudflare Access and trusted-header adapters that populate `subject.groups`
  (067 follow-ups).
- Policy-analyzer web page inputs for subject groups and group rows
  (`AdminPolicyAnalyzerPage.tsx` around lines 1306–1390). The API supports them
  after Step 9.
- Config-driven grants such as "every project tagged `ns/finance/*` gives
  group X editor" (069). Provisioning group rows in bulk (070). Using
  `member_groups` for snapshot-only list filtering at scale (071).
- MCP member-management tools.
- A `GET /projects?member_group=` admin filter for auditing which projects a
  group can reach.
