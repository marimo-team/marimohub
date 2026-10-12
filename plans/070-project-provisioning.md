# Plan 070: Project provisioning: service accounts, `external_id`, `mohub projects apply`, repository rules

> From GitHub issue marimo-team/marimohub#456. An org with hundreds of
> repositories and projects wants to provision projects, memberships, and the
> GitHub repository allowlist through the API or infrastructure-as-code, without
> a human clicking through the UI. Sibling plans: 066 (tag paths as namespaces,
> `tag_prefix` list filter), 067 (bounded IdP group set on the subject), 068
> (group member rows `{group, role}`), 069 (config-driven access rules), 071
> (list scale). This plan covers provisioning ergonomics. It works without
> 066–069, and it says where those plans plug in.

## Status

- **Priority**: P2 (enterprise onboarding at scale; interim for SCIM)
- **Effort**: L (four S–M pieces, each shippable alone in the order A → B → C → D)
- **Risk**: MED-HIGH. A opens project-scoped authority to machine credentials.
  D changes a security allowlist. Both are access-control changes.
- **Depends on**: none for A, B, or D's globs and the H2 check. C needs B.
  D's `external_id_prefix` selector needs B. C carries `{group}` member rows
  only after 068 lands.
- **Category**: auth / API / CLI / source control
- **Planned at**: 2026-10-07

## Current state

Verified against `ms/pre-release-review-v0.4.17` (commit `4f46aaa0`).

### Service accounts (A)

- `packages/core/src/tokenGrants.ts:34-36`: `SERVICE_ACCOUNT_ACTIONS =
  ['org-integration.manage']`. `serviceAccountGrantAllowsAction` (`:38-48`)
  requires the action to be in that list and in the grant. `tokenGrantAllowsAction`
  (`:75-82`) denies deployment-scope actions for project-scoped grants and
  otherwise checks `grant.actions.includes(action)`. `tokenGrantAllowsProject`
  is at `:84-89`.
- `packages/core/src/services/tokens/ServiceAccountCredentials.ts`: the
  `mhub_sa_` verifier. `AccountSchema.actions` (`:30-34`) is
  `z.enum(SERVICE_ACCOUNT_ACTIONS)`. `verify` (`:104-131`) returns the principal
  `id = UserId.parse('service-account:<id>')`, `email =
  <id>@service-accounts.invalid`, and `credential = { kind: 'service-account',
  grant: { actions, projects: '*' } }`.
- `packages/config/src/serviceAccount.ts:40-44` (`serviceAccountsFromEnv`)
  parses `MARIMOHUB_SERVICE_ACCOUNTS`. The spec entry is
  `packages/config/src/spec.ts:1478-1484`. Wiring is at
  `packages/config/src/index.ts:617` and `:748`.
- `packages/core/src/services/authorization/actions.ts`: `DEPLOYMENT_ACTIONS`
  (`:21-36`), `PROJECT_ACTIONS` (`:38-65`), and the `ACTION_RULES` table
  (`:125-168`). `project.update` and `project.members.manage` are `manager` /
  `forbidden`. `project.read` (`:135`) covers **all read-tier content**:
  metadata, notebooks, versions, and downloads.
- `packages/core/src/services/authorization/AuthorizationService.ts`:
  - `decideBaseline` (`:518`). Its service-account branch (`:544-557`) denies
    every non-deployment resource with `credential-resource` **before** any
    action check. This is stronger than the action list alone: today no grant
    can admit a service account to a project.
  - `listsAllProjects` (`:672`), `credentialAllowsAction` (`:708-714`),
    `decideCredential` (`:729-754`). For a service account, `decideCredential`
    calls `serviceAccountGrantAllowsAction` and then `tokenGrantAllowsAction`
    (an exact `includes`).
  - `decideDeployment` (`:756-780`). `project.create` → `canCreateProject`;
    `admin.access` / `org-integration.manage` / `audit.global.read` →
    `isSuperAdmin`. Service accounts never reach it: the branch at `:544`
    returns first.
  - `authorize` (`:299-332`) runs the baseline, then label constraints, then
    `decideCredential`.
- `packages/api/src/createApi.ts:516-524`: service-account requests skip
  `initializeForSubject`. On an empty bucket, `CatalogService.mutateSnapshot`
  throws `NotInitializedError` (`packages/core/src/errors.ts:175-181`, 409
  `NOT_INITIALIZED`).
- `packages/core/src/ids.ts:208-225`: `UserId` is an opaque brand (any
  non-empty string), so `service-account:<id>` parses. But
  `packages/core/src/authz.ts:141` makes the owner implicitly `admin`.
  `ProjectService.updateMemberRoleWithMutation` (`ProjectService.ts:622`) and
  `removeMemberWithMutation` (`:658`) refuse to touch the owner. No route
  transfers ownership.
- `apps/cli/src/service_account.rs:107-111` rejects any `actions` value other
  than `["org-integration.manage"]`. `:222` hardcodes it for new accounts.
- `docs/service-accounts.md` says: "Project access … excluded" and
  "Machine provisioning creates no projects."

### Projects API (B, C)

- `packages/core/src/schema.ts`: `SnapshotProjectEntrySchema` (`:233-278`,
  `looseObject`), `PublicProjectEntry` and `toPublicProjectEntry` (`:306-347`,
  an explicit pick), `ProjectMemberSchema` (`:393-401`, exactly one of
  `user_id` / `email`), `ProjectSchema` (`:424-447`).
- `packages/core/src/services/content/ProjectService.ts`:
  `CreateProjectInput` / `UpdateProjectInput` (`:57-69`); `listProjects`
  (`:224-284`, role-based admission through `entryRole` `:286`);
  `createProject` (`:337-397`), which puts `project.json` and then
  `mutateSnapshot('project.create')` in a saga and sets `owner = actor` with
  member row `{ user_id: actor, role: 'admin' }`; `updateProject` (`:399-435`);
  `addMemberWithMutation` (`:567-600`), which returns 409 for a duplicate id or
  email; `writeMembers` / `mutateMemberObject` (`:678-722`), a single ETag CAS
  on `project.json` that bumps `updated_at`; `deleteProjectWithMutation`
  (`:781-840`, soft delete; no restore route exists); `hardDeleteProject`
  (`:869`); `sweepDeletedProjects` (`:899-925`). The constructor
  (`:215-221`) already takes an `InviteIdentityResolver` (emails → user ids).
- `packages/core/src/services/content/catalogProjection.ts:79-98`
  (`projectCatalogPatch`) projects `project.json` into the snapshot entry.
- `packages/api/src/routes/projects.ts`: `CreateProjectBody` (`:64-72`),
  `UpdateProjectBody` (`:74-82`), `AddMemberBody` (`:89-97`),
  `visibleMembers` (`:125-134`, full roster only for `manager`+),
  `projectResponse` (`:136-149`). Route definitions are at `:153-358`.
  Handlers: list `:362`, create `:381` (uses `idempotentCreate(c, 'POST
  /projects', …)`), get `:398`, update `:409`, delete `:469`, members
  `:493-621`.
- `packages/api/src/shared.ts`: `ProjectMemberResponseSchema` (`:1060-1066`),
  `ProjectResponseSchema` (`:1126-1143`), API `SnapshotProjectEntrySchema`
  (`:1162-1176`), `loadVisibleProject` (`:703-712`), `assertProjectRole`
  (`:176-186`), `assertDeploymentAction` (`:1698-1710`).
- `packages/api/src/pagination.ts:39-68`: `ListFilterQuery` (`tag`, `q`) and
  `ProjectListQuery`.
- `packages/api/src/idempotency.ts:6-77`: replay is keyed per user, route, and
  key, with a body fingerprint. "Concurrent first requests can both execute"
  (`:47`). So `Idempotency-Key` alone cannot make create-by-external-id unique.
- **Member identity gap**: an id row stores no email. `NewMember` carries the
  email only for the duplicate check (`ProjectService.ts:71-78`). A client
  that declares `email = "a@x"` cannot tell from `GET …/members` whether the
  row `{ user_id: u1 }` is that person. A client-side member diff is therefore
  impossible for email-declared members.
- The name-claim precedent is `acquireSingletonClaim` /
  `releaseSingletonClaim` (`packages/core/src/services/catalog/cas.ts:91-187`),
  used by `ProjectIntegrationsStore.claimName` / `releaseName`
  (`ProjectIntegrationsStore.ts:1738-1777`). The store writes the head first and
  claims second (`:470-492`); a rename claims the new name and frees the old
  (`:540-611`). Paths: `paths.ts:280`, `:410-411`. Bucket spec:
  `development_docs/bucket_spec.md:242-245` and §4.12 (`:839`).

### CLI (C)

- `apps/cli/src/cli.rs`: `deploy_command` (`:214-243`) and
  `service_account_command` (`:245-297`). `build` (`:299-410`) injects
  `notebooks deploy` into the generated `notebooks` subtree with an assert
  that the manifest does not define it (`:397-405`).
- `apps/cli/src/main.rs:695-797` (`run_command`): `service-account generate`
  at `:702`, `notebooks deploy` at `:744-775`.
- `apps/cli/src/deploy.rs`: plan-all-then-write, `planned|updated|unchanged`
  aggregate output, and a partial-failure message listing what was already
  applied (`:219-268`). `apps/cli/src/deploy_config.rs`: `marimohub.toml` /
  `[tool.marimohub]` discovery (`:11-12`, `:159-190`, `load` `:498`).
  `project_id` is required, so a projects list cannot share that file.
- `apps/cli/src/client.rs`: `notebook_deployment_state` (`:646-699`, GET plus
  ETag) and `update_notebook_deployment` (`:701-725`, PATCH with `If-Match`)
  are the patterns to copy.
- Tests: `apps/cli/tests/cli.rs` (stub HTTP server `serve_sequence` `:31`,
  deploy tests `:225-900`), `apps/cli/tests/service_account.rs`. CI:
  `.github/workflows/cli.yml:31-56` runs `cargo fmt --all -- --check`,
  `cargo clippy --all-targets --locked -- -D warnings`, and
  `cargo test --locked` in `apps/cli`, plus `pnpm --filter @marimo-hub/api test
  cliManifest.spec`.

### Repository rules (D)

- `packages/config/src/sourceControl.ts:22` (`makeSourceControl`), `:61-85`:
  this code parses `MARIMOHUB_SOURCE_CONTROL_GITHUB_ALLOWED_REPOSITORIES`
  through `projectResourceRules` (`packages/config/src/projectResourcePolicy.ts:6-24`),
  canonicalizes each resource to `{origin}/{owner}/{repo}` in lowercase, and
  builds a **synchronous** `authorize(repository, projectId?)` that throws
  `ForbiddenError('Repository is not allowed for this project.')`.
- `packages/core/src/projectResourcePolicy.ts:1-25`: `{resource, projects:
  '*' | ProjectId[]}` with exact `resource` match. **This module is shared with
  the AWS Secrets Manager allowlist** (`packages/secrets-aws/src/index.ts:65-79`,
  `packages/config/src/secrets.ts:115`). Selector changes must not silently
  change that variable's grammar.
- `packages/config/src/sourceControlRegistry.ts:9-95`: `getReader` /
  `getPublisher` take `projectId?` only. `supportsRepository` (`:48-52`) is
  synchronous. Guarded operations are async.
- Port: `packages/core/src/ports/sourceControl.ts:262-272`
  (`SourceControlRegistry.getPublisher/getReader(provider, projectId?)`).
  Callers: `packages/api/src/routes/sourcePullSync.ts:33-74`
  (`requireSyncReader`, `assertPullSourceSupported`, `resolveSyncTarget`),
  `packages/api/src/routes/changeRequestPublishing.ts:42-52`,
  `packages/core/src/services/content/NotebookPreviewService.ts:93-107`
  (`source()`), and `packages/api/src/routes/system.ts:108` (no project).
- Push-mode gap (audit H2, `plans/security-audit-2026-09-23.md:76-82`):
  `createGitNotebook` (`packages/api/src/routes/notebooks.ts:1242-1306`) and
  `updateGitSource` (`:1319-1335`) consult the allowlist only when
  `sync_mode === 'pull'` (`:1253-1255`, `:1331`). Push-mode sources store any
  repository unchecked. The GitHub App calls themselves (reader and publisher)
  are guarded, so the failure surfaces late: at preview, drift, or PR publish.
  `applyGitSourceUpdate` refuses `sync_mode` changes
  (`packages/core/src/integrations/syncedSource.ts:185-187`), so a push source
  cannot be switched to pull to skip the check.
- Docs: `docs/syncing.md:517-536` ("GitHub project policies") ends with
  "Restart the hub to apply policy changes." The spec entry is
  `packages/config/src/spec.ts:1869-1875`.

### Out of scope today

- MCP (`packages/api/src/mcp/server.ts`) registers no project or member tools.

## Design

### A. Service-account project provisioning: one coarse `project.provision` action

Add **`project.provision`** to `DEPLOYMENT_ACTIONS`. It is the only new
service-account action. It implies a fixed, bounded set of project
operations on every project the account can see:

```ts
// tokenGrants.ts
export const SERVICE_ACCOUNT_ACTIONS = ['org-integration.manage', 'project.provision'] as const;
/** Actions a `project.provision` service account holds on every unlabeled, active project. */
export const PROVISION_IMPLIED_ACTIONS = [
	'project.create',
	'project.update',
	'project.members.manage',
] as const satisfies readonly AuthorizationAction[];
```

Reasons to choose one coarse action over listing `project.create` +
`project.update` + `project.members.manage` + `project.read` in
`MARIMOHUB_SERVICE_ACCOUNTS`:

- Service-account grants are always `projects: '*'` (`ServiceAccountCredentials.ts:127`).
  A project-scoped action list would suggest per-project scoping that does not
  exist. One deployment action states the real scope: all projects.
- **`project.read` must not be implied.** It gates notebook content,
  versions, and downloads (`actions.ts:40`). The provisioning routes get
  metadata access through a dedicated helper (below). A provisioning account
  never reads notebook code.
- `project.delete`, `security-labels.*`, `notebook.*`, `integration.*`,
  `session.*`, and `admin.access` stay unreachable.

Authorization changes (`AuthorizationService.ts`):

- `decideBaseline` service-account branch (`:544-557`): keep the deny, except
  when `resource.kind === 'project'`, the action is in
  `PROVISION_IMPLIED_ACTIONS`, and `serviceAccountGrantAllowsAction(grant,
  action)` holds. In that case, apply the lifecycle check first (deleted →
  `lifecycle`). Then return `{ allowed: true, role: null }` with
  `labelSets = [project.security_labels]` (filtered for non-null), so
  `authorize` runs the constraint pass. A service account has no
  `subjectContextRef`, so **labeled projects fail closed** as `constraint`
  (404). This is intended: label authority stays with humans.
- `serviceAccountGrantAllowsAction(grant, action)`: true when `action` is in
  the grant directly, or when the grant holds `project.provision` and `action`
  is in `PROVISION_IMPLIED_ACTIONS`.
- `decideCredential` (`:729-754`): for `kind === 'service-account'`, return
  allowed once `credentialAllowsAction` passes and the resource check passes.
  Do **not** fall through to the exact `tokenGrantAllowsAction` at `:751`,
  which would reject implied actions.
- New public `provisionsAllProjects(subject): boolean`. It is true only for a
  service account whose grant allows `project.provision`. It is used by list
  and metadata reads.
- `decideDeployment` (`:756-780`): add `case 'project.provision': return
  isSuperAdmin(...)`. Human super admins can set `external_id` (B) and
  namespace tags (D). A PAT carrying `project.provision` gives a non-super-admin
  nothing.
- Service accounts bypass `MARIMOHUB_PROJECT_CREATION=restricted` for
  `project.create`. The operator granted `project.provision` explicitly in
  config. Document this.

Metadata reads for provisioning accounts (`packages/api/src/shared.ts`): add
`loadProvisionableProject(projects, pid, subject, deps)`. If
`provisionsAllProjects(subject)`, it calls `getProject`, returns 404 for
`status === 'deleted'` or present `security_labels`, and returns the project.
Otherwise it delegates to `loadVisibleProject`. Use it in `getProject` (`:398`)
and `listMembers` (`:493`) only. `ProjectService.listProjects` (`:224`) gets
a branch before the `credentialAllowsAction(…, action)` throw at `:236-238`. When
`authz.provisionsAllProjects(subject)` holds, it admits every matching
non-deleted entry and then runs the existing `filterByLabelConstraints`
(labeled entries drop out).

Response shape for provisioning callers: `projectResponse` returns
`your_role: null` and the **full roster** (`visibleMembers` takes a
`fullRoster` boolean = `roleAtLeast(role,'manager') ||
provisionsAllProjects(subject)`).

**Owner of a provisioned project: always a human.** A service account cannot
be the owner. The owner is implicitly admin (`authz.ts:141`), cannot be
demoted or removed (`ProjectService.ts:622`, `:658`), and has no transfer
route, so a machine owner would leave a project with no removable admin.

- `CreateProjectBody` gets optional `owner: { user_id } | { email }` (exactly
  one, same refine as `AddMemberBody`).
- Service-account callers **must** send `owner`. A missing owner returns 400
  `ValidationError('owner is required when a service account creates a project')`.
  The email must resolve through `identities.getByEmail` to a known identity;
  otherwise 400 `owner must be a user who has signed in at least once`. The
  owner is a `UserId`, and pending invites cannot own projects. Reject any id
  that starts with `SERVICE_ACCOUNT_USER_PREFIX`.
- Human callers: `owner` may be omitted, or it must resolve to the caller.
  Otherwise the request fails with 403 unless the caller is a super admin.
  Create-on-behalf for super admins is a small extension of the same check;
  include it.
- `CreateProjectInput` gets `owner?: UserId`. `createProject(input, actor)`
  uses `owner = input.owner ?? actor` for `owner` and the admin member row.
  `actor` stays the service account, so the snapshot `project.create` audit
  actor is `service-account:<id>`.
- Member rows (`addMember`, reconcile in C) reject `user_id` values with the
  `service-account:` prefix (400). Service accounts ignore memberships anyway,
  and this keeps rosters human.

Empty deployment: keep `createApi.ts:516-524` unchanged. Provisioning on an
uninitialized bucket returns 409 `NOT_INITIALIZED`. The first human sign-in
still creates the human-owned default project. Document "sign in once
first". `mohub projects apply` prints that hint on `NOT_INITIALIZED`.

Configuration: `MARIMOHUB_SERVICE_ACCOUNTS` accepts `"actions":
["project.provision"]` or both actions. The schema extends automatically
from `SERVICE_ACCOUNT_ACTIONS`. Update the spec description at
`spec.ts:1481-1482`. CLI `service-account generate` gets a repeatable
`--action` (default `org-integration.manage`). `service_account.rs:107` accepts
any non-empty duplicate-free subset of the two actions. `:222` uses the flag
values.

### B. Idempotent create through `external_id`

Add an optional, immutable-by-default **`external_id`**: the IaC system's
stable key for a project.

- Schema: `ExternalIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/)`
  with refines: no `//`, no `..` segment, no trailing `/`. Lowercase only, so
  no case collisions. Put it in `packages/core/src/schema.ts` near
  `ProjectSchema`.
  - `ProjectSchema` (`:424-447`): `external_id: ExternalIdSchema.optional()`.
  - `SnapshotProjectEntrySchema` (`:233-278`): `external_id:
    z.string().optional()`. It is loose, so old replicas preserve it.
  - `PublicProjectEntry` / `toPublicProjectEntry` (`:306-347`): add
    `external_id`. API `SnapshotProjectEntrySchema` (`shared.ts:1162`) and
    `ProjectResponseSchema` (`shared.ts:1126`): `external_id:
    z.string().optional()`.
  - `projectCatalogPatch` (`catalogProjection.ts:84-98`) and the
    `createProject` snapshot entry (`ProjectService.ts:370-392`) project
    `external_id`.
- **Uniqueness claim**: `_system/project-external-ids/{encodeURIComponent(external_id)}.json`
  holds `{ project_id: string | null, claimed_at }`. The single owner is
  **`ProjectService`**. It uses the integration name-claim pattern exactly:
  `acquireSingletonClaim` / `releaseSingletonClaim`. `isHolderLive(holder)` =
  `project.json` exists, `status !== 'deleted'`, and `external_id ===
  <this id>`. That makes a leaked claim self-heal.
  - Add `paths.projectExternalIdClaim(externalId)` and
    `paths.projectExternalIdClaimsPrefix` beside `orgIntegrationNameClaim`
    (`paths.ts:410-411`).
  - Create order (`createProject` saga): `write_meta` (compensate delete) →
    `claim_external_id` (on `acquired: false`, throw `ConflictError(\`external_id
    "${id}" is already used by another project\`)`; compensate release) →
    `catalog`. This is head first, claim second, as in
    `ProjectIntegrationsStore.ts:470-492`.
  - Update (`updateProject`): `external_id: string | null | undefined`.
    Changing it follows the rename order in `ProjectIntegrationsStore.ts:540-611`:
    write `project.json` under `assertVersionMatch`, claim the new id
    (compensate: revert the field), then release the old id after commit.
    `null` clears the field and releases the claim.
  - Delete: `deleteProjectWithMutation` releases the claim after the
    tombstone commits. With no restore route, re-applying the same
    `external_id` then creates a fresh project. `hardDeleteProject` calls
    release again (idempotent). Free markers (`project_id: null`) are kept,
    like integration name claims. Their number is bounded by distinct ids ever
    used.
- **Who may set it**: any request body that carries `external_id` (create or
  update) first calls `assertDeploymentAction(user, 'project.provision', deps,
  'Setting external_id requires project provisioning permission')`. A
  provisioning service account or a super admin passes. Without this gate,
  any user with open project creation could squat claims and block the IaC
  run. D's `external_id_prefix` selector also depends on this gate.
- **Lookup**: `GET /projects?external_id=<id>` is an exact-match filter.
  Add `external_id` to `ProjectListQuery` (`pagination.ts:58-68`) and to the
  `listProjects` filter type, where it is applied before authorization. A
  legacy entry without the field never matches.
- **Chosen flow: "GET by `external_id`, then POST or PATCH."** The claim
  returns 409 to a concurrent duplicate POST, and the client re-GETs. Keep
  `Idempotency-Key` on `POST /projects` for network-retry replay. It is not a
  uniqueness mechanism (`idempotency.ts:47`).
- **Rejected for B**: `PUT /projects/by-external-id/{external_id}` upsert. It
  would need PUT semantics over owner, members, and federation, and a second
  create path that duplicates `createProject` and its authorization. GET then
  POST/PATCH reuses existing routes. Every OpenAPI change here is additive:
  optional request properties, optional response properties, and one optional
  query parameter. That passes the oasdiff gate
  (`internal/schemas/README.md:55-60`).

### C. Server-side member reconciliation + `mohub projects apply`

**Server primitive.** Clients cannot diff email-declared members (see
"Member identity gap"). Add one route that lets the server resolve identities
and apply the diff in **one CAS** on `project.json`:

`POST /projects/{pid}/members/reconcile` (operationId
`projects.members.reconcile`). It requires `project.members.manage`, so a
provisioning account passes through A. It accepts an optional `If-Match`.

```jsonc
// request
{ "members": [ { "user_id": "…", "role": "editor" }, { "email": "a@x.com", "role": "viewer" } ],
  "prune": false, "dry_run": false }
// response 200
{ "success": true, "data": {
    "project": Project,
    "changes": [ { "member": { "user_id": "…" }, "action": "added|updated|removed|unchanged",
                   "role": "editor", "previous_role": "viewer" } ] } }
```

- Core: `ProjectService.reconcileMembersWithMutation(id, desired, { prune,
  dryRun, expectedVersion }, actor)`. It runs inside `mutateMemberObject`
  (`:690-722`) with `assertVersionMatch`. Resolve desired emails with the
  injected `resolveIdentitiesByEmail`. A known email targets the id row (and
  any invite row for that email, same rule as `addMemberWithMutation`
  `:577-586`). An unknown email targets or creates an invite row. Roles must
  be `ASSIGNABLE_ROLES`. A desired entry that names the owner returns 400
  ("the owner is implicitly admin; remove it from members"). `prune` removes
  unmatched rows and **never** the owner row. `dryRun` computes `changes` and
  writes nothing. A no-op skips the write and the catalog update. Otherwise,
  `catalog.updateProjectEntry('project.members', …)` runs as in `writeMembers`
  (`:678-688`).
- Bounds: at most 500 desired entries. Duplicate selectors return 400.
- Notifications: before the write, call `assertNotificationMutationAllowed`
  for every added or invited recipient (so a 429 means nothing was written).
  After commit, schedule the same `member.added` / `member.invited` /
  `member.role_changed` / `member.removed` alerts as the single-member routes
  (`projects.ts:502-621`). Factor those render blocks into helpers instead of
  copying them.
- After 068: entries accept `{ group, role }`. The diff keys group rows on the
  group name, and this route needs no other change. Until 068, `group` fails
  schema validation (400).

**CLI command: `mohub projects apply`.** It is hand-written and injected into
the generated `projects` subtree like `notebooks deploy`.

- Config file: `projects.toml` in the current directory by default.
  Override with `--config PATH`. There is no ancestor discovery. A separate
  file is needed because `marimohub.toml` requires `project_id`
  (`deploy_config.rs`). Format:

  ```toml
  [defaults]
  owner = "platform-lead@example.com"   # email (contains @) or user id; used only on create

  [[projects]]
  external_id = "dep1/analytics"
  name = "Analytics"
  description = "Team analytics notebooks"
  tags = ["dep1", "analytics"]
  owner = "lead@example.com"            # optional; overrides [defaults].owner
  members = [
    { email = "a@example.com", role = "editor" },
    { user_id = "user_01HXY…", role = "viewer" },
    # { group = "data-science", role = "viewer" },   # after plan 068
  ]
  ```

  Unknown keys are errors. `external_id` must be unique in the file and match
  the server regex. `name` is required. Omitted `description`, `tags`, or
  `members` preserve remote values (same rule as deploy). `members = []` with
  `--prune-members` removes every non-owner row. The file holds no URLs or
  credentials.
- Flags: `--config PATH`, `--dry-run`, `--prune-members` (default off),
  `--project EXTERNAL_ID` (repeatable selector). `--raw-envelope` is rejected,
  as for deploy.
- Reconcile algorithm (plan everything, then write):
  1. Parse and validate locally, before resolving the profile (mirrors
     `invalid_local_configuration_fails_before_profile_resolution`).
  2. For each selected project: `GET /projects?external_id=<id>` (0 or 1
     items). If found, `GET /projects/{pid}`, which returns the detail and
     `ETag`. Diff `name`, `description`, and `tags` (ordered comparison, like
     deploy) into a PATCH body. If `members` is declared, call
     `POST …/members/reconcile` with `dry_run: true` and `prune` from the flag
     to get the planned member changes. If not found, plan `create`.
  3. If `--dry-run`, print the plan and stop.
  4. Execute in file order. **Create**: `POST /projects` with `external_id`,
     `name`, `description`, `tags`, `owner`, and
     `Idempotency-Key: sha256(external_id + canonical entry)`. On 409 for
     `external_id`, re-run step 2 for that project. It may be a concurrent
     apply, or a labeled project the credential cannot see; report that case
     as an error. Then reconcile members with the create response's ETag.
     **Update**: `PATCH /projects/{pid}` with `If-Match`, then reconcile
     members with `If-Match` set to the PATCH response ETag. On 412, stop with
     "changed concurrently; re-run apply". Do not retry, like
     `precondition_failure_is_not_retried`.
  5. Print one aggregate result: `{ config, dry_run, projects: [ {
     external_id, project_id, action: planned|created|updated|unchanged,
     changes: [field names], members: { added, updated, removed } } ] }`.
     On failure, list the projects already applied (copy `deploy.rs:236-251`).
- Ownership semantics: `owner` applies **only on create**. Ownership is never
  reconciled because no transfer route exists. If the configured owner
  differs from a remote owner, report it in `changes` as `owner (not
  applied)`.
- `apply` **never deletes projects**. Projects missing from the file are left
  alone. `--delete-missing` is a follow-up and needs a list-all by
  external_id (071).
- On `NOT_INITIALIZED`, print: "the hub has no catalog yet; sign in once as a
  human, then re-run".

### D. Repository-rule ergonomics + the push-mode gap

Extend only the **source-control** rule grammar. The AWS secrets grammar
stays unchanged.

- Core (`packages/core/src/projectResourcePolicy.ts`): add
  `parseScopedProjectResourceRules` and `allowsScopedProjectResource(rules,
  resource, project?: ProjectResourceScope)`, where `ProjectResourceScope =
  { id: ProjectId; tags?: readonly string[]; external_id?: string }`. Grammar:
  - `projects`: `'*'` | `ProjectId[]` | `{ tag_prefix?: string;
    external_id_prefix?: string }`. The object needs at least one key; when
    both are set, both must match. A `tag_prefix` matches when some tag
    `startsWith(prefix)`. With 066, prefixes are path-shaped (`"dep1/"`). An
    `external_id_prefix` matches `external_id.startsWith(prefix)`. A scope
    without `tags` or `external_id` **does not match** a selector rule (fail
    closed).
  - `resource`: an exact canonical URL, `'*'`, or an **owner glob**
    `{origin}/{owner}/*`. The glob matches exactly one following path segment.
  - Keep `parseProjectResourceRules` / `allowsProjectResource` unchanged for
    `MARIMOHUB_SECRETS_AWS_ALLOWED_SECRETS`.
- Config (`sourceControl.ts:61-80`): parse with the scoped parser. Add a
  `projectResourceRules` option or a sibling `scopedProjectResourceRules` in
  `packages/config/src/projectResourcePolicy.ts`. `canonical()` accepts
  `owner/*` (github.com) and `https://ghes.example/owner/*`. Lowercase the
  owner and keep `/*`.
- Port (`ports/sourceControl.ts:262-265`): widen to
  `getPublisher/getReader(provider, project?: ProjectId | ProjectResourceScope)`
  and add `authorizeRepository?(repository: string, project:
  ProjectResourceScope): void` (throws `ForbiddenError`). The registry
  (`sourceControlRegistry.ts`) normalizes a bare id to `{ id }`. Callers that
  have a loaded `Project` pass `{ id, tags, external_id }`:
  - `sourcePullSync.ts`: change `requireSyncReader` /
    `assertPullSourceSupported` / `resolveSyncTarget` to take `project:
    Pick<Project, 'id' | 'tags' | 'external_id'>`. Update the calls at
    `notebooks.ts:1254`, `:1331`, `:1344` (each has `project` in scope) and
    `sourcePullSync.ts:102`.
  - `changeRequestPublishing.ts:42-52`: pass `input.project`.
  - `NotebookPreviewService.source()` (`:93-107`): load `project.json` with
    `readStored(ProjectSchema, …, paths.project(pid).meta)`, which the service
    has `bucket` for, and pass the scope. Background `preparePending` gets
    correct scopes the same way.
  - `system.ts:108`: unchanged (no project; previews capability probe).
- **Tag governance.** This is required, or `tag_prefix` becomes self-service
  privilege escalation: tags are writable by any project `manager`
  (`project.update`), so a manager could add `dep1/x` and gain the repository.
  **This is the same gate as 069's protected namespace tags; do not build a
  second one.** 069 defines `AuthzPolicy.namespaceTagPrefixes` (the union of
  `MARIMOHUB_AUTHZ_NAMESPACE_TAG_PREFIXES` and every access rule's
  `tag_prefix`), a pure `namespaceTags(tags, prefixes)` helper, a
  `NamespaceTagAuthority` value computed in the route and enforced **inside**
  the `mutateObject` callback of `ProjectService.createProject` /
  `updateProject`, and the `project.namespace_tags` audit event.
  `makeSourceControl` contributes every repository rule's `tag_prefix` to that
  same union in `packages/config/src/index.ts:777-794`. The authority gains one
  more way to be satisfied: `provisionsAllProjects(subject)` (a
  `project.provision` service account) sets `mayChangeAll`. Tag-prefix
  matching uses 066's `tagMatchesPrefix` (segment-aligned), not `startsWith`.
  If 069 has not landed, implement the minimal subset here (the prefix union,
  `namespaceTags`, the in-CAS gate with only super-admin-session and
  `project.provision` as authorities) under 069's names, so 069 extends it with
  steward delegation instead of replacing it.
- **Push-mode H2 check.** In `createGitNotebook` (`notebooks.ts:1252-1255`)
  and `updateGitSource` (`:1329-1331`), for **both** sync modes, when
  `providerForRepo(prospective, repo, deps.sourceControl?.repositoryHosts)`
  names a configured provider, call
  `deps.sourceControl?.authorizeRepository?.(repo, { id, tags, external_id })`
  before any write. The error is the registry's existing 403
  `ForbiddenError('Repository is not allowed for this project.')`. Repositories
  on unconfigured hosts (no provider) stay allowed. The policy governs the
  GitHub App only. Pull mode keeps `assertPullSourceSupported`.
- **Restart to apply.** The policy stays env-driven and needs a restart on
  every replica. A bucket-stored, super-admin-managed binding (H2's "source-control
  binding") is a follow-up. Moving the provisioning rules into the bucket would
  need a new CAS owner, which this plan does not add.

### Rejected

- **SCIM** is deferred per the decision record in `plans/README.md:138-143`.
  marimohub would be a SCIM server, and the domain lacks lifecycle and groups.
  This plan plus 049/067/068 is the interim.
- **A Terraform provider** lives outside this repository. The stable REST
  surface from B and C is what a provider would call. `mohub projects apply`
  covers the in-repo IaC case.
- **Unique project names as the idempotency key**: this breaks existing
  deployments that have duplicate names, makes rename a uniqueness event, and
  ties the human label to the machine key. `external_id` separates them.
- **A service account as project owner**: ownership is irremovable and
  untransferable (see A).
- **Listing `project.read` for service accounts**: it exposes all notebook
  content. Metadata reads use `loadProvisionableProject` instead.
- **A client-side member diff**: id rows carry no email. A server-side
  reconcile is also one CAS instead of N writes.
- **Extending the shared `parseProjectResourceRules`**: it would silently give
  the AWS secrets variable selectors that its resolver cannot evaluate.

## Steps

Each part ends green: root `pnpm check && pnpm typecheck && pnpm test`.

### Part A: service-account provisioning

1. Core `actions.ts`: add `'project.provision'` to `DEPLOYMENT_ACTIONS`
   (`:21-36`, with a doc comment) and `'project.provision': { scope:
   'deployment' }` to `ACTION_RULES` (`:128-132`).
2. Core `tokenGrants.ts:34-48`: extend `SERVICE_ACCOUNT_ACTIONS`, add
   `PROVISION_IMPLIED_ACTIONS`, and make `serviceAccountGrantAllowsAction`
   implication-aware.
3. Core `AuthorizationService.ts`: change the `decideBaseline` SA branch
   (`:544-557`), the `decideCredential` SA path (`:729-754`), and
   `decideDeployment` (`:756-780`, add `project.provision`), and add
   `provisionsAllProjects`. Tests in `AuthorizationService.test.ts`:
   - an SA with `project.provision` is allowed `project.update` and
     `project.members.manage` on an active, unlabeled project;
   - it is denied `project.read`, `project.delete`, `notebook.write`,
     `integration.manage`, `security-labels.raise`, and every session action;
   - it gets `lifecycle` on a deleted project and `constraint` on a labeled
     project;
   - an SA with only `org-integration.manage` is still denied
     `credential-resource` on projects;
   - human super admin → `project.provision` allowed; non-super-admin PAT
     holding `project.provision` → `standing` denied.

   Update `packages/api/src/authorizationCharacterization.test.ts` snapshots
   with `vp test -u`, and review the diff by hand.
4. Core `ProjectService`: `CreateProjectInput.owner`; `createProject` uses it
   (`:337-397`); the `listProjects` SA branch (`:224-284`). Tests in
   `ProjectService.test.ts`.
5. API `projects.ts`: `owner` in `CreateProjectBody` (`:64-72`); owner
   resolution and the rules in the create handler (`:381-396`);
   `fullRoster` in `visibleMembers` / `projectResponse` (`:125-149`); reject
   `service-account:` member ids in `addMember` (`:502`). API `shared.ts`:
   `loadProvisionableProject`, used by `getProject` (`:398`) and
   `listMembers` (`:493`). Extend `packages/api/src/routes/serviceAccount.test.ts`:
   - SA creates with an owner email → 201, owner = that user, snapshot actor
     `service-account:<id>`;
   - no owner → 400; unknown email → 400;
   - lists and gets unlabeled projects, does not see labeled ones;
   - `GET …/notebooks` → 404;
   - `DELETE /projects/{pid}` → 404 or 403;
   - `/me/tokens` still refused;
   - an empty bucket returns 409 `NOT_INITIALIZED`.
6. Config: spec description (`spec.ts:1478-1484`). Regenerate
   `docs/configuration.md` with `pnpm --filter @marimo-hub/config
   docs:generate`. Update the config wizard snapshots if they change
   (`vp test -u`).
7. CLI `service_account.rs`: add `--action` (repeatable, default
   `org-integration.manage`) in `cli.rs:245-297`. Validation at `:107`
   accepts any subset of the two actions; `:222` uses the flag. Extend
   `apps/cli/tests/service_account.rs`.
8. Docs: `docs/service-accounts.md` (new "Provision projects" section;
   rewrite the "excluded" sentence; table row for `actions`; owner rule; empty
   deployment rule; labeled projects invisible). `docs/api-tokens.md`
   (`project.provision` is super-admin-only for PATs).

### Part B: `external_id`

9. Core `schema.ts`: `ExternalIdSchema`, `ProjectSchema.external_id`,
   snapshot entry field, `PublicProjectEntry` / `toPublicProjectEntry`.
   `catalogProjection.ts:84-98`. `paths.ts`: `projectExternalIdClaim` and its
   prefix.
10. Core `ProjectService`: claim config (`serialize`, `parseHolder`,
    `isHolderLive`); create saga step; `updateProject` change and clear with
    compensation; release in `deleteProjectWithMutation` and
    `hardDeleteProject`; `external_id` filter in `listProjects`. Tests:
    - two concurrent creates with the same id → exactly one succeeds, the
      other gets `ConflictError` and its meta is compensated away;
    - stale-claim self-heal (claim written, meta deleted);
    - change and clear release the old claim;
    - delete frees the id and a new project can take it;
    - legacy entries never match the filter.
11. API: `external_id` in `CreateProjectBody` / `UpdateProjectBody`
    (`projects.ts:64-82`, `z.union([ExternalIdSchema, z.null()])` for update,
    following the `federation` pattern at `:78-81`); the `project.provision`
    gate; `external_id` in `ProjectListQuery` (`pagination.ts:58-68`); response
    schemas (`shared.ts:1126`, `:1162`). Tests in `projects.test.ts`: a human
    manager setting `external_id` → 403; super admin → 200; duplicate → 409
    `CONFLICT`; exact filter.
12. Bucket spec: add `_system/project-external-ids/{external_id}.json` to the
    layout table in `development_docs/bucket_spec.md` (beside `:242-245`) and
    a short subsection next to §4.12 (claim class, head-first order, release
    on delete, sole writer `ProjectService`). **Add the owner line to the
    CLAUDE.md invariant list** (after the `ProjectIntegrationsStore` entry):
    "`ProjectService` owns each external-id claim at
    `_system/project-external-ids/{external_id}.json` (singleton claim,
    released on project delete)."
13. `pnpm schemas:generate` regenerates `packages/api/openapi.yaml`,
    `internal/schemas/bucket.yml`, the CLI manifest, and the client. Confirm
    the oasdiff output shows only additive changes.

### Part C: reconcile + `projects apply` (needs B)

14. Core: `ProjectService.reconcileMembersWithMutation` plus types
    (`DesiredMember`, `MemberChange`). Tests: add, update, unchanged, prune
    on and off, owner protection, known-email to id-row match, invite rows,
    dry run writes nothing, no-op skips the catalog commit, `If-Match` stale →
    `PreconditionFailedError`.
15. API: `reconcileMembers` route in `projects.ts`. Extract the notification
    render helpers from `:502-621`. Tests: provisioning SA and manager both
    succeed; viewer → 403; 501 entries → 400; notification pre-check returns
    429 with nothing written.
16. `pnpm schemas:generate`. The generated manifest gains `projects members
    reconcile`.
17. CLI: add `src/projects_config.rs` (TOML model and validation, unit
    tests), `src/projects_apply.rs` (plan and execute, modeled on
    `deploy.rs`), and `client.rs` helpers (`find_project_by_external_id`,
    `project_detail` → `(Value, etag)`, `create_project`, `update_project`
    with If-Match, `reconcile_members`). Wire `apply_command()` into `cli.rs`
    `build` next to the deploy injection (`:397-405`, with the same
    "manifest does not define it" assert) and into `main.rs::run_command`
    next to `:744`. Register the modules in `src/lib.rs`. Integration tests
    in `apps/cli/tests/cli.rs` using `serve_sequence`:
    - dry run makes no writes;
    - create sends `external_id`, `owner`, and `Idempotency-Key`;
    - update sends the preflight ETag;
    - members reconcile uses the PATCH ETag;
    - `--prune-members` is passed through;
    - 409 on create re-reads;
    - 412 is not retried;
    - partial failure lists applied projects;
    - invalid config fails before profile resolution;
    - `NOT_INITIALIZED` hint.
18. Docs: `docs/cli.md`, new section "Apply projects from configuration"
    after "Deploy notebooks from configuration" (`:190-277`): file format,
    flags, actions, ownership and never-delete semantics, CI example with a
    service-account token. `docs/api.md` (`:62-65`): `external_id`, the exact
    filter, the reconcile route.

### Part D: repository rules + H2

19. Core `projectResourcePolicy.ts`: scoped parser and matcher. Tests for
    owner globs (one segment only), each selector, combined selectors, fail
    closed without scope, and an unchanged legacy parser.
20. Core port `sourceControl.ts:262-265`: widen `getReader` / `getPublisher`,
    add `authorizeRepository?`, export `ProjectResourceScope`. Core
    `authz.ts`: extend 069's `namespaceTagPrefixes` union and `NamespaceTagAuthority` (see D).
21. Config: `sourceControl.ts` (scoped rules, glob canonicalization,
    the rule `tag_prefix` list exposed from `SourceControlConfig` for the 069 prefix union), `sourceControlRegistry.ts`
    (scope normalization, `authorizeRepository`), and the `index.ts` policy
    merge (`:777-794`). Tests in `sourceControl.test.ts` /
    `sourceControlRegistry.test.ts`.
22. API: scope threading through `sourcePullSync.ts`,
    `changeRequestPublishing.ts`, and `NotebookPreviewService.source`; push-
    and pull-mode `authorizeRepository` in `notebooks.ts:1252-1255` and
    `:1329-1331`; the 069 namespace-tag gate with the `project.provision` authority in `projects.ts` create and update. Tests:
    - push-mode create for a disallowed repository → 403, no notebook
      written; allowed → 201;
    - push-mode source update to a disallowed repository → 403;
    - a non-GitHub host is unaffected;
    - a manager adding a namespace tag → 403, a provisioning SA → 200;
    - a tag-selected project can pull, an untagged one cannot.
23. Docs: `docs/syncing.md` "GitHub project policies" (`:517-536`): owner
    globs, selectors, the namespace-tag rule, push-mode enforcement, restart
    note. Update the `spec.ts:1869-1875` description and regenerate
    `docs/configuration.md`.

### Final

24. Review the full diff and strip AI-slop comments: restatements of what
    the code does, change narration, and doc blocks that only repeat the
    signature. Keep only comments that explain *why*.

## Verification

- `pnpm --filter @marimo-hub/core test`
- `pnpm --filter @marimo-hub/api test` (includes `openapi.spec`,
  `cliManifest.spec`, `authorizationCharacterization`)
- `pnpm --filter @marimo-hub/config test`
- `cd apps/cli && cargo fmt --all -- --check && cargo clippy --all-targets
  --locked -- -D warnings && cargo test --locked`
- `pnpm schemas:generate`, then `git diff --stat` shows only the expected
  generated files (the specs, `apps/cli/generated/cli-manifest.json`,
  `packages/client/src/schema.ts`, `internal/schemas/bucket.yml`).
- Root: `pnpm check && pnpm typecheck && pnpm test`, then `pnpm build`.
- Manual (dev server with `MARIMOHUB_SERVICE_ACCOUNTS` holding a
  `project.provision` account; sign in once as a human first):
  1. `mohub projects apply --dry-run` on a three-project `projects.toml` →
     three `planned` entries.
  2. Apply → three `created` entries.
  3. Re-apply → three `unchanged` entries.
  4. Edit one description and one member role, apply → one `updated` entry.
  5. Remove a member, apply with `--prune-members` → `removed` appears.
  6. `curl` with the SA token to `GET /projects/{pid}/notebooks` → 404.
  7. Set `MARIMOHUB_SOURCE_CONTROL_GITHUB_ALLOWED_REPOSITORIES='[{"resource":"myorg/*","projects":{"tag_prefix":"dep1/"}}]'`.
     A push-mode git notebook in an untagged project for `myorg/x` → 403.
     After the SA adds the tag `dep1/a` → 201.

## STOP conditions

- **A new CAS or claim record without exactly one owner.** The external-id
  claim belongs to `ProjectService` only. If another service (import, admin,
  MCP) needs to write it, STOP and route the write through `ProjectService`.
  If the CLAUDE.md invariant list and `bucket_spec.md` cannot be updated in
  the same change, STOP.
- **Any path where a service account escalates.** That includes: reaching
  `admin.access`, `audit.global.read`, `security-labels.*`, `project.read`
  content routes, notebooks, sessions, or integrations; minting or managing
  PATs (`/me/tokens` must stay session-only); becoming a project owner or
  member; or gaining super-admin standing. If the `decideBaseline` change
  cannot be scoped to exactly `PROVISION_IMPLIED_ACTIONS`, STOP and report.
- If `filterByLabelConstraints` or `authorize` would admit a labeled project
  for a service account (for example, a constraint adapter that allows a null
  context), STOP. Labeled projects must fail closed for machines.
- If an OpenAPI change from this plan trips oasdiff at error level, STOP.
  Everything here must be additive. Do not add `allowed-breaking` entries.
- If threading `ProjectResourceScope` reaches beyond the callers listed in D
  (for example, a scheduled pull-sync path in core that has only an id and no
  bucket access), STOP and report instead of letting tag selectors silently
  fail closed there.
- If 069 has landed with a tag gate whose names or enforcement point differ
  from what D assumes (`namespaceTagPrefixes`, `NamespaceTagAuthority`, the
  in-CAS check), extend 069's gate; never add a parallel `governedTagPrefixes`
  mechanism. If the two cannot be unified, STOP and reconcile.

## Follow-ups (out of scope)

- MCP project and member tools (`packages/api/src/mcp/server.ts` has none).
  These need their own token-scope review.
- `mohub projects apply --delete-missing`, after 071 adds an efficient list by
  `external_id` prefix. It needs soft-delete confirmation UX.
- Ownership transfer (`PUT /projects/{pid}/owner`). After it exists, `apply`
  can reconcile `owner`.
- A bucket-stored, super-admin-managed source-control binding (audit H2's
  long-term fix) to remove "restart to apply". It needs a new CAS owner and an
  admin UI.
- A GC sweep for free external-id claim markers (`project_id: null`).
- Integration provisioning in `apply` (`[[integrations]]`) on top of the
  existing org integration API.
- A Terraform provider (outside this repository) built on B and C.
- `{ group, role }` rows in `apply` and reconcile, when 068 lands.
