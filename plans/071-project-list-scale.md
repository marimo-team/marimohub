# Plan 071: Project listing at hundreds of projects (cost, caching, filters, sorting, benchmark)

> From GitHub issue marimo-team/marimohub#456. An org is evaluating marimohub
> for hundreds of projects and thousands of notebooks. The maintainer's answer
> was "should scale to 100s of projects / 1000s notebooks, but it has only been
> benchmarked locally". This plan replaces that guess with numbers. It removes
> the one per-project read on the list path, caches the parsed snapshot, adds
> `owner=me` / `member=me` / `sort` / `order` to `GET /projects`, adds a
> repeatable benchmark, and documents the limits.
>
> Part of the 066–071 series:
> - **066**: tag paths, the `tag_prefix` filter, project-list grouping UI, and
>   **page-through-all in the web client**. 066 owns the client fix to
>   `useProjectsQuery`.
> - **067**: a bounded group set on the subject.
> - **068**: group member rows and a `member_groups` snapshot projection.
> - **069**: access rules evaluated from the snapshot `tags`.
> - **070**: provisioning.
> - **071 (this plan)**: the server side of listing and the new API filters.

## Status

- **Priority**: P2 (adoption blocker for large orgs; correct today, only slow)
- **Effort**: M
- **Risk**: MED. It changes which source of truth list authorization reads, so
  a mistake can **over-grant visibility**. It also adds a field to the CAS-managed
  snapshot entry and needs a two-release rollout (Phase 1 writes the field,
  Phase 2 reads it).
- **Depends on**: none. Coordinates with 066 (client paging, `tag_prefix` in
  `ProjectListQuery`) and 068 (group rows; see "Group rows").
- **Category**: perf / scale / API
- **Planned at**: 2026-10-07

## Current state (verified 2026-10-07)

### The list path: `ProjectService.listProjects`

Code: `packages/core/src/services/content/ProjectService.ts:223-284`.

1. Line 248: `this.catalog.getCurrentSnapshot()` makes **2 GETs**: `_system/catalog.json`,
   then the snapshot object. It also runs a full zod parse of the whole snapshot
   with `SnapshotSchema`. Nothing is cached: `CatalogService.getCurrentSnapshot`
   (`packages/core/src/services/catalog/CatalogService.ts:120-122`) calls
   `readSnapshot(await readCurrentCatalog())` (`:191-209`) on every call. The only
   in-process cache in `CatalogService` is `involvementIndex` (`:56`, `:124-176`).
   It is keyed by `current_snapshot_key` and is used only by
   `hasProjectInvolvement`. Its comment, "cache candidates, never authorization
   decisions", is the right rule.
2. Lines 249-255: the `status` and `q` filtering happens in memory
   (`createListFilter`, `packages/core/src/services/content/listFilters.ts:12-25`).
3. Lines 256-265: the `tag` filter. If an entry has no `tags` (a legacy entry),
   the code reads `project.json` through the memoised `loadProject` (`:239-247`).
4. Lines 268-273: authorization. For **every** matching entry the code calls
   `entryRole` (`:286-307`). `entryRole` returns `admin` without a read only for
   super admins and the owner (`:298`). For any other caller it **always**
   reads `project.json` through `getProject` (`:329-335`, uncached), then calls
   `effectiveRole`. The fan-out uses `mapWithConcurrency(…, BUCKET_SCAN_CONCURRENCY)`
   with `BUCKET_SCAN_CONCURRENCY = 16` (`packages/core/src/constants.ts:137`).
   The comment at `:299-300` gives the reason: "A roster projection can lag a
   committed membership change. Even a miss cannot prove that a more restrictive
   explicit membership is absent." An explicit `app-user` or `viewer` row ranks
   below the deployment default (`MARIMOHUB_DEFAULT_ROLE`, default `editor`,
   `packages/config/src/spec.ts:1624-1629`), and explicit membership always wins
   (`packages/core/src/authz.ts:142-158`). The snapshot holds ids, not roles, so
   it cannot answer the question.
5. Lines 275-283: `filterByLabelConstraints`
   (`packages/core/src/services/authorization/labelFilter.ts:21-40`). It reads
   `project.json` (same memo) **only** for entries whose tri-state
   `security_labels` is `undefined`, which means legacy or pending. Determinate
   entries cost nothing.

**Measured cost per `GET /projects` for a caller who is not the owner and not a
super admin, with N matching projects: 2 + N GETs.** This holds under both
`defaultRole=editor` and `defaultRole=none`. Under `none`, a stranger with zero
memberships still pays all N reads and gets back an empty list. The API then
paginates in memory (below), so **each page request pays the full 2 + N
again**. A client that pages with `limit=100` over 500 projects issues
5 × 502 ≈ 2,500 GETs. With S3-class latency (~20 ms p50) and 16-way fan-out,
one request costs about N/16 × 20 ms ≈ 625 ms at N=500, and the latency is
almost all `project.json` reads.

### Other callers that pay the same per-entry cost

- `ProjectService.isAppOnly` (`:309-327`) is called on **every
  `GET /api/v1/me`** (`packages/api/src/routes/system.ts:55`) and by
  `deploymentDecision` for `project.create`
  (`packages/api/src/shared.ts:1680-1695`, call at `:1692`). It does
  `bucket.head(catalog)` + snapshot + `entryRole` in batches of 16. Under
  `defaultRole=editor` it stops after the first batch (16 reads; the test
  "stops scanning account roles after finding viewer access",
  `ProjectService.test.ts:316-325`, pins this). Under `defaultRole=none` with
  few memberships it reads **all N**.
- `listProjects` is also called by `packages/api/src/routes/apps.ts:100`
  (`action: 'app.read'`), by `packages/api/src/mcp/selectors.ts:46` (name lookup),
  by `packages/api/src/mcp/server.ts:88`, and by `apps/server/src/devSetup.ts:290`
  (unfiltered).

### Snapshot-only helpers exist but are unused

`canSeeProjectEntry` (`packages/core/src/authz.ts:202-237`) and
`AuthorizationService.projectEntryVisibility`
(`packages/core/src/services/authorization/AuthorizationService.ts:687-706`)
have **no production callers**. A grep finds only their tests
(`authz.test.ts:307-378`, `AuthorizationService.test.ts:141,518-527,735-772`).
`canSeeProjectEntry` also **over-grants**: it returns `true` whenever
`subjectDefaultRole ≥ viewer` (`:228`), even when an explicit `app-user` row
exists. That is the exact case `entryRole`'s comment guards against.
`listsAllProjects` (`:672-685`) has one live use: `directory.search` (`:769-770`).
`listProjects` does not use any of the three.

### Writing membership is two steps, not one CAS

The comment above `writeMembers` (`ProjectService.ts:672-677`) says "in the
same catalog CAS". That is misleading. `writeMembers` (`:678-688`) runs:

1. `mutateMemberObject` (`:690-718`): an ETag CAS on `project.json`.
2. **Then** `catalog.updateProjectEntry('project.members', …)`
   (`CatalogService.ts:317-339` → `mutateSnapshot`). Its patch is
   `loadProjectCatalogPatch` (`catalogProjection.ts:67-77`). The patch re-reads
   `project.json` **inside** each catalog CAS attempt and projects
   `member_ids` / `member_emails` (`projectCatalogPatch`, `:79-100`).

So the lag is real. If the process crashes or step 2 fails after step 1, the
snapshot keeps the old roster with no marker. The test "stale %s membership
projection" (`ProjectService.test.ts:228-262`) simulates exactly this with
`vi.spyOn(catalog, 'updateProjectEntry').mockRejectedValueOnce(...)`. The
pattern that does handle this safely already exists for labels:
`setSecurityLabels` (`:437-523`) parks the projection at indeterminate with
`security_labels_pending: true` **before** the authoritative write, then
finalizes. Routine projections preserve the marker
(`securityLabelsProjection`, `catalogProjection.ts:34-52`).

The only code that writes `project.json` `members` is `createProject`
(`:356-394`) and `mutateMemberObject`. `mutateMemberObject` is called by
add/update/remove (`:575`, `:619`, `:655`) and by the invite claim
(`claimProjectInvites`, `:720-751`, from the maintenance sweep
`claimPendingInvites`, `:754-768`). The `owner` field never changes after
creation.

### Snapshot size

Every project entry embeds its full `notebooks[]`
(`SnapshotProjectEntrySchema.notebooks`, `packages/core/src/schema.ts:233-278`;
`SnapshotNotebookEntrySchema`, `:194-226`). One notebook entry serializes to
about **460–500 B**. That covers ids `proj-`/`nb-` + 16 chars, timestamps,
tags, `key_prefix`, and optional `jobs[]`. A project entry without notebooks
is about **650 B** with 8 members. I estimated with `JSON.stringify` on
representative entries:

| Projects × notebooks | Snapshot bytes | `JSON.parse` (Node 24, M-series) |
| -------------------- | -------------- | -------------------------------- |
| 100 × 10             | ~0.56 MB       | ~1 ms                            |
| 500 × 20             | ~5.3 MB        | ~6 ms                            |
| 1000 × 20            | ~10.6 MB       | ~11 ms                           |
| 1000 × 50            | ~25.5 MB       | ~27 ms                           |

The zod `SnapshotSchema` parse costs several times `JSON.parse`. The benchmark
(Step 7) measures it. **Every** `mutateSnapshot` (`CatalogService.ts:215-309`)
re-reads and re-PUTs the whole object, so write amplification at 500×20 is
about 5 MB per notebook save. This plan documents that ceiling and does not fix
it (see Follow-ups).

### Pagination and the route

- `paginate()` (`packages/api/src/pagination.ts:143-173`) sorts the entire list
  in memory, `created_at` descending with an `id` tiebreak (`comparator`, `:98-101`).
  The default page is 100 (`:18`), the max is 500 (`:20`, clamped). The cursor
  is `btoa(JSON.stringify([key, tiebreak]))` (`encodeCursor`/`decodeCursor`,
  `:113-134`). It carries **no** sort or filter identity.
- `ProjectListQuery` (`:58-68`) = pagination + `status` + `tag` + `q`.
- Route definition: `packages/api/src/routes/projects.ts:153-172`. Its
  description says: "When paging a filtered list, send the same filters with
  each cursor." Handler: `:362-378`, keyed `created_at` / `id`. The response
  item schema is `SnapshotProjectEntrySchema` in `packages/api/src/shared.ts:1162-1176`.
  This is the public projection, separate from the core schema, and it has no
  `members`.
- Web: `useProjectsQuery` (`packages/web/src/api/hooks.ts:415-434`) fetches
  **one** page. **066 owns this fix.** `useProjectPickerQuery` (`:881-895`) already
  pages everything with `limit: 500` through `listAllCursorPages`.

### Prior art and tooling

- Plans 018 and 029 made the session scans page-complete and scoped. 029
  explicitly left the project list alone ("a full read is one GET") because the
  per-entry `project.json` reads were added later, by the authz
  centralization work.
- Plan 032 added `status`/`tag`/`q` and deferred sort params ("lower value").
  This plan picks that up.
- No benchmark or load-test harness exists. A grep for `bench`, `benchmark`, and
  `load-test` finds nothing outside `node_modules`, and `scripts/` contains only
  release and dev tooling. Env-gated vitest files are the established pattern
  for "not in the default run": `describe.skipIf(!configJson ...)` in
  `packages/core/src/services/integrations/kinds/databricks.browse.live.test.ts:9`,
  and `UPDATE_SCHEMAS=1 vp test ...` in `packages/core/package.json:77`.
- `RecordingBucket` (`packages/core/src/testing/RecordingBucket.ts`, exported
  from `@marimo-hub/core/testing`) already records every `get`/`head`/`put`/
  `list` call, so no new counting wrapper is needed.
  `setupTestEnv()` (`packages/core/src/testing/fixtures.ts:210-215`) always
  builds a bare `MemoryBucket`. A counting test calls
  `createServices(new RecordingBucket())` directly.
- `development_docs/bucket_spec.md:1389-1394` documents the current rule:
  "Catalog entries carry `member_ids` and `member_emails`, but no roles …
  Listings resolve membership from `project.json`". This plan changes that rule.
- Rolling-deploy policy: `development_docs/migrations.md:59-123`. Snapshot
  entries are `looseObject`, so an **old replica preserves unknown fields
  unchanged** through its read-modify-write, and "a genuinely breaking change is
  a two-phase deploy" (`:113-117`).

## Design

### 1. Make the snapshot roster authoritative enough to skip `project.json`

**Recommendation: option (a), the roles projection with a pending fence, plus
a parsed-snapshot cache (§2). Reject option (b), the TTL cache of
`project.json`, for authorization.**

#### Projection fields (additive, `SnapshotProjectEntrySchema`, `schema.ts:233-278`)

```ts
/**
 * Role-bearing copy of `project.json` `members`, so list authorization can
 * resolve `effectiveRole` without the authoritative read. Trusted only when
 * `members_pending` is absent or empty and it agrees with `member_ids` /
 * `member_emails` (see `projectEntryRole`). Absent = legacy, so indeterminate.
 */
members: z.array(ProjectMemberSchema).optional(),
/**
 * One token per membership mutation in flight: added before the
 * `project.json` write, removed by that mutation's own finalization.
 * Non-empty = `members` is indeterminate. Routine projections preserve it.
 */
members_pending: z.array(z.string()).optional(),
```

`ProjectMemberSchema` is at `schema.ts:393-401` and is declared **after** the
snapshot schemas. Move it above `SnapshotNotebookEntrySchema`, or reference it
lazily. Do not duplicate it.

Why a list of tokens and not `true`: the label marker is a boolean, so
concurrent mutations can clear each other's fence. Suppose mutation A
finalizes while mutation B has parked but not yet written; then B crashes. The
label code has this latent hole (see Follow-ups). Membership must not copy it.
A token is a ULID (`ulid()` from `ulidx`, which core already uses in
`DeepLinkService.ts:1`). Each mutation removes only its own token. `members`
becomes trusted again only when the list is empty.

#### Write ordering (the trust model)

Every code path that writes `project.json` `members` follows this order:

1. **Park**: `catalog.updateProjectEntry('project.members.pending', …)`
   appends `token` to `members_pending`.
2. **Authoritative write**: `mutateMemberObject` CAS on `project.json` (unchanged).
3. **Finalize**: `catalog.updateProjectEntry('project.members', …)` with
   `loadProjectCatalogPatch(bucket, id, entry, { finalizeMembers: token })`.
   This re-reads `project.json` in-CAS (as today), writes `members`,
   `member_ids`, and `member_emails`, and removes `token`.
4. **Rollback on a pre-write rejection.** `mutateMemberObject` throws
   `NotFoundError` / `ConflictError` / `ValidationError` from inside its callback
   before the put. In that case run the same finalize, which removes the token
   and re-projects, inside a try/catch that logs
   `members_projection_rollback_failed` and rethrows the original error. This
   mirrors `unparkSecurityLabels` (`ProjectService.ts:533-550`). Any other failure
   is ambiguous (the put may have committed), so leave the token in place, which
   fails closed.

A crash anywhere between 1 and 3 leaves a token, which means indeterminate.
The reader then falls back to `project.json`. That is today's behavior, so the
change never fails open. A snapshot-only decision is used only when no
mutation is in flight. When no mutation is in flight, the in-CAS projection in
step 3 equals `project.json`.

`createProject` (`:356-394`) writes `project.json` **before** the snapshot entry
exists, so no reader can see a stale entry. Its literal entry (`:370-388`)
adds `members: project.members` and no pending field.

`claimProjectInvites` (`:720-751`) goes through park, write, and finalize too.
The repair branch (`result.written === false`, projection stale) needs no
token, because it does not write `project.json`.

#### Routine projections

`projectCatalogPatch` (`catalogProjection.ts:79-100`) also projects
`members: project.members` and leaves `members_pending` untouched: the spread
`{ ...entry, ...patch }` in `updateProjectEntry` (`CatalogService.ts:333-335`)
preserves it. This matches how routine projections treat
`security_labels_pending`. Add a `finalizeMembers?: string` option next to
`finalizeSecurityLabels` in `SecurityLabelProjectionOptions` (rename to
`ProjectionOptions`, `:16-26`). Only that option removes a token.
`deleteProjectWithMutation` (`:822-832`) and `updateProject` (`:430-432`) keep
working unchanged and refresh `members` for free.

#### Reader: one pure function in `authz.ts`

```ts
/**
 * The caller's role decided from a snapshot entry alone, or `undefined` when
 * the entry cannot decide it (legacy, mutation in flight, or a roster that an
 * older replica changed without updating `members`). `undefined` MUST fall back
 * to `project.json`, never to "no role" or the default.
 */
export function projectEntryRole(
	entry: Pick<SnapshotProjectEntry, 'owner' | 'members' | 'members_pending' | 'member_ids' | 'member_emails'>,
	subject: AuthSubject,
	policy?: AuthzPolicy,
): Role | null | undefined
```

- Super admin, or `entry.owner === subject.id`, returns `'admin'`. This is
  today's `entryRole` fast path.
- `members === undefined` or `members_pending?.length` returns `undefined`.
- **Cross-check**: if the set of `members[].user_id` ≠ `member_ids`, or the set
  of folded `members[].email` ≠ folded `member_emails`, return `undefined`. An
  older replica's add or remove updates the id arrays but preserves a stale
  `members` (looseObject). This catches it. A role-only change by an older
  replica is **not** caught; the two-phase rollout covers that case (below).
- Otherwise return `resolveEffectiveRole({ owner: entry.owner, members: entry.members }, subject, policy).role`.
  Widen `resolveEffectiveRole` / `effectiveRole` (`authz.ts:122-178`) to take
  `Pick<Project, 'owner' | 'members'>`. Both fields are structurally the same
  as `Project`'s, so existing call sites compile unchanged.
- **069 interaction.** Once 069 lands, access rules need the project id and
  tags. Widen the `Pick` to `'id' | 'tags'` as well and pass the snapshot
  `tags` through. A legacy entry without `tags` returns `undefined`
  (indeterminate) whenever a `tag_prefix` rule names one of the subject's
  groups; 069's `resolveAccessRuleRole` returns `null` for exactly that case.
  A rule match never short-circuits the explicit-row cross-check above.

Delete `canSeeProjectEntry` (`authz.ts:202-237`) and
`AuthorizationService.projectEntryVisibility` (`AuthorizationService.ts:687-706`)
and their tests. They are dead in production and over-grant on explicit
`app-user` rows. Add `AuthorizationService.projectEntryRole(subject, entry)`.
It applies the credential checks `projectEntryVisibility` had today
(`credentialAllowsAction` + `tokenGrantAllowsProject`) and delegates to the
pure function.

#### `listProjects` / `isAppOnly` after the change

`entryRole` (`ProjectService.ts:286-307`) becomes:
`projectEntryRole(...) ?? (await loadProject(entry.id))` → `effectiveRole`, with
`NotFoundError` → `null` as today. The `loadProject` memo map stays per call.
**No role is cached across requests.** The test "does not cache roles across
listing or account requests" (`:286-300`) must stay green unchanged.
`isAppOnly` uses the same `entryRole`. Its batching loop can stay; with
determinate entries it makes zero reads.

Expected cost after Phase 2 + backfill: **2 GETs** per list request (or 1, see
§2), regardless of N. Legacy, pending, or mismatched entries each cost exactly
one `project.json` read, as today.

#### Group rows (068)

If 068 stores group rows inside `project.json` `members` (for example
`{ group, role }`), then `members` carries them verbatim and
`resolveEffectiveRole` already handles them. 068's separate `member_groups`
projection is then only a filter aid. The cross-check must also compare the
group set when 068 lands. **Coordinate:** whichever of 068 and 071 merges
second extends `projectEntryRole`'s cross-check and the `member=me` filter
(§3) to group rows. If 068 stores group rows somewhere other than
`project.json` `members`, then 068 must fence them with the same token
protocol before `projectEntryRole` may trust them. Otherwise that kind of row
returns `undefined`.

#### Rollout: two releases (required by `migrations.md:113-117`)

- **Phase 1 (release A)** ships everything that **writes**: the schema fields,
  park/finalize, routine projection, `createProject`, and the backfill and
  repair maintenance step (below). `entryRole` still always reads
  `project.json`. Behavior does not change.
- **Phase 2 (release B, after A is fully rolled out)** ships `projectEntryRole`
  trust in `entryRole` and `isAppOnly`. Release-note text: *"Upgrade through
  release A first. If you skip it, do not change project member roles until
  every replica runs B. The maintenance repair heals any drift within one
  cycle (5 min) after the rollout completes."*

#### Backfill and drift repair (maintenance, Phase 1)

New method `ProjectService.repairMemberProjections(): Promise<number>`:

- Reads the snapshot. For every non-deleted entry, reads `project.json`
  (`mapWithConcurrency`, 16) and computes `projectCatalogPatch`. It selects
  entries where `members` is missing, `members`/`member_ids`/`member_emails`
  differ from the projection, `tags` is missing, or `security_labels` is
  `undefined` without `security_labels_pending`. It also selects entries
  where every `members_pending` token's ULID time (`decodeTime` from `ulidx`)
  is older than `MEMBER_PROJECTION_PENDING_STALE_MS`.
- Applies **one** `catalog.mutateSnapshot('project.members.repair', SYSTEM_ACTOR, …)`.
  Inside it, each selected entry is re-read from `project.json` in-CAS (the
  same rule as `loadProjectCatalogPatch`). Stale tokens are dropped only in
  this step. Keep the batch to entries that differ, so a steady-state cycle
  commits nothing.
- New constant in `packages/core/src/constants.ts` (next to
  `BUCKET_SCAN_CONCURRENCY`, `:137`): `MEMBER_PROJECTION_PENDING_STALE_MS =
  Millis.minutes(15)`, with a why-comment. `mutateMemberObject`'s CAS retries are
  bounded and requests time out well under 15 min. A token older than that
  belongs to a dead request.
- Cost: N `project.json` GETs per 5-min cycle **on the maintenance replica
  only**. At N=500 that is 500 GETs / 5 min, which is negligible.
- Wire it after `claimPendingInvites` in `apps/server/src/cron.ts:154`
  (report `member_projections_repaired` in the returned counts at `:166-182`)
  and in `examples/cloudflare-worker/src/index.ts:291`.

Rejected for authorization, option (b): **a short-TTL in-process cache of
`project.json` keyed by `(id, snapshot updated_at)`.** It has the same lag as
an unfenced projection. During the lag window the entry's `updated_at` has not
moved, so the cache serves the pre-revocation record. It is also per-replica.
The repo already decided "cache candidates, never authorization decisions"
(`CatalogService.ts:125`) and pins it with the test at
`ProjectService.test.ts:286`.

### 2. Cache the parsed snapshot (safe: snapshot objects are immutable)

Snapshot keys are unique per commit (`createSnapshotId()`,
`CatalogService.ts:244`), and a committed snapshot object is never rewritten.
In `CatalogService`, add a single-slot cache
`{ key: string; value: Promise<Snapshot> }` used by `getCurrentSnapshot`
(`:120-122`):

- It still reads `_system/catalog.json` on **every** call. This is the
  freshness check, and it costs 1 small GET.
- When `catalog.current_snapshot_key` equals the cached key, it returns the
  cached parsed snapshot. Otherwise it reads, parses, replaces the slot, and
  evicts the slot on rejection (as `involvementIndex` does at `:159-165`).
- `involvementIndex` reuses the same cached snapshot.
- `mutateSnapshot` keeps reading through its own uncached path (`:227-242`).
  The CAS must see the bytes it swaps against.
- **Mutation hazard.** The cached object is shared. Audit the 14 production
  call sites of `getCurrentSnapshot()` (CatalogService ×3, NotebookService ×2,
  ProjectService ×5, `services/index.ts` ×1, JobScheduler ×2,
  RuntimeInspectionService ×1) to confirm none mutates the returned
  snapshot. They currently map/filter into new arrays. Type the return as
  `DeepReadonly<Snapshot>` only if that does not ripple. Otherwise add a test
  that deep-freezes the cached value under vitest (`import.meta.env.MODE === 'test'`)
  so any mutation throws in CI.

Result: list cost becomes 1 catalog GET + 0 snapshot GETs + 0 parses in steady
state. This also helps `listNotebooks`, `isAppOnly`, and the job scheduler.

### 3. Filters and sort on `GET /projects`

Add to `ProjectListQuery` (`packages/api/src/pagination.ts:58-68`):

| Param    | Schema                                                    | Semantics |
| -------- | --------------------------------------------------------- | --------- |
| `owner`  | `z.enum(['me']).optional()`                               | `entry.owner === caller.id`. |
| `member` | `z.enum(['me']).optional()`                               | Caller has an **explicit** member row: id in `member_ids`, folded email in `member_emails` (and a 068 group row once it lands). Owners match too, because `createProject` adds the owner as an `admin` row (`ProjectService.ts:348`). |
| `sort`   | `z.enum(['created_at', 'updated_at', 'name']).optional()` | Default `created_at`. `updated_at` reflects notebook activity (`appendNotebookEntry` bumps it, `CatalogService.ts:377`). |
| `order`  | `z.enum(['asc', 'desc']).optional()`                      | Default `desc` for timestamps and `asc` for `name`. |

`'me'`-only enums leave room for super-admin `owner=<user-id>` later without a
breaking change.

- **Core.** Extend the `listProjects` filter arg (`ProjectService.ts:225-230`)
  with `owner?: 'me'; member?: 'me'`. Apply both **after** status/q/tag and
  **before** the role check, so non-matching entries never cost a read. They
  narrow the set only. They are never an authorization input: the role and
  label checks still run on the narrowed set. So the roster can safely be read
  from the snapshot without the pending fence. For a legacy entry
  (`member_ids === undefined`), resolve `member=me` from the memoised
  `loadProject`. Keep `createListFilter` generic. Do not add subject-aware
  fields to `ListFilters` (`listFilters.ts:1-5`).
- **API sort.** Generalize `paginate` (`pagination.ts:143-173`) so `SortKeys<T>`
  gains `direction: 'asc' | 'desc'` (default `'desc'`). `comparator` (`:98-101`)
  and the boundary test (`:158-161`) must use the same direction-aware compare.
  For `name`, key = `foldCase(entry.name)` (`identityMatch.ts`, exported from
  core) with the id tiebreak. Keep `localeCompare` as the single comparison
  primitive, so the sort and the cursor boundary agree exactly.
- **Cursor stability.** Today's cursor is `[key, tiebreak]`. Keep exactly that
  encoding for the default sort, so cursors already issued keep working.
  Non-default sorts encode `[`${sort}:${order}`, key, tiebreak]`.
  `decodeCursor` (`:117-134`) accepts length 2 (implicitly `created_at:desc`)
  or 3, and the route returns **400 `BAD_REQUEST`, "Cursor does not match the
  requested sort"** when the cursor's sort tag differs from the request's.
  Filters stay outside the cursor, as plan 032 decided. The keyset boundary
  stays well-defined when filters change: the client gets "items after
  position X in the new set", never a crash or a duplicate within one
  filter set. Keep the route description and extend it: "Send the same
  filters, `sort`, and `order` with each cursor." Update `docs/api.md:124-126`.
- **NotebookListQuery is unchanged.** Keep `paginate`'s default behavior
  byte-identical for `routes/notebooks.ts` and every other `paginate` caller
  (grep `paginate(` in `packages/api/src`).
- Regenerate specs with `pnpm schemas:generate`. This updates
  `packages/api/openapi.yaml`, the client, and `internal/schemas/bucket.yml`
  (the new snapshot fields). All additions are optional, so oasdiff stays
  non-breaking. `packages/web/src/types/index.ts:53`
  (`ProjectListFilters = Pick<ProjectListQuery, 'q' | 'status' | 'tag'>`) is
  left for 066 to widen.

### 4. Document the limits

Add a "Project and notebook counts" subsection under `docs/operations.md`
"Scaling" (`:73`). It must contain the measured table from Step 7 (list p50
read count and wall time at N=100/500/1000, `defaultRole=editor|none`,
before/after) and the snapshot-size ceiling. A 500×20 snapshot is about
5 MB, re-PUT on every catalog write and parsed once per snapshot change per
replica. Give the guidance: above ~1,000 projects or ~20,000 notebooks, expect
the snapshot write amplification to dominate, and treat that as the next
limit. Update `development_docs/bucket_spec.md:1389-1394` to describe the
`members` / `members_pending` projection, the token protocol, and the
indeterminate fallback. Add a rolling-deploy paragraph to
`development_docs/migrations.md` after `:66-73` (the label paragraph).

## Rejected

- **A secondary index object per user** (`_system/user-projects/{uid}.json`).
  It adds a new CAS-managed record type with a new owner, plus fan-out writes
  on every membership change. It cannot represent "everyone with the default
  role", which is the common open-deployment case. It only moves the lag
  problem into a second object. The fenced snapshot projection keeps one source
  (`mutateSnapshot`) and needs no new owner in the key-invariant list.
- **Moving the catalog to a database.** This is contrary to the bucket-only,
  ports-and-adapters architecture (CLAUDE.md). At 500 projects the snapshot is
  about 5 MB and parses in milliseconds. The bottleneck was N round trips,
  which this plan removes inside the existing model.
- **A server-side grouping endpoint** (`GET /projects/groups`). Grouping is a
  presentation concern over tags (066). With list cost O(1) in bucket reads
  and 066's page-through-all, the client can group a complete list.
- **A TTL cache of `project.json` or of roles.** See §1. It serves revoked
  access during the lag.
- **Trusting `member_ids` alone, as `canSeeProjectEntry` does.** It cannot
  rank an explicit `app-user`/`viewer` row against a higher default. Deleted.
- **Raising `BUCKET_SCAN_CONCURRENCY`.** It treats the symptom, is shared with
  every scan, and does nothing for the per-page multiplier.
- **Server-side pagination push-down** (sorting before authz to stop early).
  Hidden projects must not affect cursors (`ProjectService.ts:267`), so the
  authz filter must see the whole set. That costs nothing once roles are in
  memory.

## Steps

Phase 1 (release A): Steps 1–5 and 7–8. Phase 2 (release B): Step 6 and Step 9's
doc updates that describe trust.

1. **Schema** (`packages/core/src/schema.ts`). Move `ProjectMemberSchema`
   (`:393-401`) above the snapshot schemas. Add `members` and `members_pending`
   to `SnapshotProjectEntrySchema` (`:233-278`) with the doc comments from §1.
   Confirm `toPublicProjectEntry` (explicit pick) and the API's
   `SnapshotProjectEntrySchema` (`packages/api/src/shared.ts:1162-1176`) do
   **not** expose either field. Add a `schema.test.ts` case: an entry with
   both fields parses, and the public projection omits them.
2. **Projection** (`packages/core/src/services/content/catalogProjection.ts`).
   Rename `SecurityLabelProjectionOptions` → `ProjectionOptions` (`:16-26`) and
   add `finalizeMembers?: string`. `projectCatalogPatch` (`:79-100`) adds
   `members: project.members`. When `finalizeMembers` is set, it also returns
   `members_pending` = entry tokens minus that token (`undefined` when empty).
   Update all importers of the old name.
3. **Write path** (`ProjectService.ts`):
   - `createProject` literal entry (`:370-388`): add `members: project.members`.
   - New private `parkMembers(id, actor): Promise<string>` (appends a ULID
     token through `updateProjectEntry('project.members.pending', …)`) and
     `finalizeMembers(id, actor, token, operation)`.
   - `writeMembers` (`:678-688`): park, then `mutateMemberObject`, then
     finalize. On `NotFoundError | ConflictError | ValidationError |
     PreconditionFailedError` from `mutateMemberObject`, finalize as a
     rollback (log `members_projection_rollback_failed` on failure) and
     rethrow. Rewrite the misleading comment at `:672-677` to describe the
     three-step fence.
   - `claimProjectInvites` (`:720-751`): park before `mutateMemberObject`. If
     `!result.written`, finalize anyway (removes the token and repairs). Keep
     the existing `projectionIsCurrent` early-return only on the no-write path,
     after the token is removed.
   - Tests in `ProjectService.test.ts`:
     - Update "stale %s membership projection" (`:228-262`) so the rejection hits
       the **finalize** call (`'project.members'`), not the park. Assert that the
       entry has a non-empty `members_pending` and that the visibility results
       are unchanged.
     - Add: concurrent A/B mutations. Interleave by stubbing
       `mutateMemberObject` via `vi.spyOn` so A finalizes while B is parked.
       Assert that `members_pending` still holds B's token.
     - Add: rejected add (duplicate → `ConflictError`) leaves no token.
     - Add: `updateProject` while a token is present preserves it.
4. **Repair** (`ProjectService.repairMemberProjections`, the constant in
   `constants.ts`, wiring in `apps/server/src/cron.ts:154` + counts, and
   `examples/cloudflare-worker/src/index.ts:291`). Tests:
   - Backfills a legacy entry with `members`, `tags`, and `security_labels`.
   - Heals a hand-edited stale `members` role (simulates an old replica).
   - Drops a token older than the stale bound and keeps a fresh one.
   - Commits no snapshot when nothing differs. Assert with `RecordingBucket`
     `calls.put` containing no `_system/catalog.json`.
   Update `apps/server/src/cron.test.ts:107` (maintenance counts shape; also
   asserted near `:318`).
5. **Snapshot cache** (`CatalogService.ts:120-122`, `:191-209`, `:124-176`) as in
   §2, plus the caller audit. Tests in `CatalogService.test.ts`:
   - Two `getCurrentSnapshot()` calls issue 2 catalog GETs and 1 snapshot GET.
   - After `mutateSnapshot`, the next call returns the new snapshot.
   - A failed read evicts the slot.
   - The deep-freeze guard catches a mutating caller.
6. **Phase 2 trust** (`authz.ts`, `AuthorizationService.ts`, `ProjectService.ts`).
   - Add `projectEntryRole` and widen `effectiveRole`/`resolveEffectiveRole` to
     `Pick<Project, 'owner' | 'members'>`.
   - Delete `canSeeProjectEntry` and `projectEntryVisibility` and their tests.
     Add `AuthorizationService.projectEntryRole` with the credential checks.
   - Make `entryRole` try the snapshot first.
   - Tests (`authz.test.ts` table-driven): owner, super admin, explicit
     `app-user` under `defaultRole=editor` (→ `app-user`, the case
     `canSeeProjectEntry` got wrong), explicit `viewer` under `manager`,
     non-member under `none` (→ `null`, **determinate**, so no read),
     `members` missing, pending token present, id-set mismatch, email-case
     differences. Each indeterminate case → `undefined`.
   - `ProjectService.test.ts`: the legacy-snapshot matrix (`:186-226`) and
     "reuses one project read …" (`:264-284`) stay green.
7. **Read-count test + benchmark** (core).
   - Always-on test in `ProjectService.test.ts`, `describe('listProjects
     read cost')`. Build `createServices(new RecordingBucket())`, seed 40
     projects (owner `ACTOR`, plus one with an explicit `app-user` row for
     `STRANGER`). Under `defaultRole: 'editor'` and `defaultRole: null`, assert
     `calls.get.filter(k => k.endsWith('/project.json'))` has length **0**
     after Phase 2. Phase 1 asserts the current N. Assert the `app-user`
     project is hidden under `editor`. Repeat for `isAppOnly`.
   - Benchmark: `packages/core/src/services/content/projectList.bench.test.ts`,
     wrapped in `describe.skipIf(!process.env.MARIMOHUB_BENCH)`. It seeds
     **N = `MARIMOHUB_BENCH_PROJECTS` (default 500) × 20 notebooks**:
     - Write each `project.json` directly with `bucket.put(paths.project(id).meta, …)`
       (5 members: owner + 4, one of them `app-user` for the bench subject on
       10% of projects).
     - Build the snapshot in **one**
       `catalog.mutateSnapshot('bench.seed', ACTOR, snap => ({ ...snap, projects }))`.
       Do not seed through `createProject`/`createNotebook`: 10k CAS commits
       re-serialize a growing ~5 MB snapshot, which is O(n²).
     - Wrap the bucket in a local `LatencyBucket` (in the bench file only, not
       exported) that adds `MARIMOHUB_BENCH_GET_MS` (default 20) to each `get`/`head`,
       over `RecordingBucket(MemoryBucket)`.
     - Measure, for a non-owner subject under `editor` and `none`: GET count, wall
       time (median of 5 after 1 warm-up), and snapshot bytes. Do this for
       `listProjects` and for `isAppOnly`.
     - Print a markdown table with `console.table`. The bench asserts only
       sanity (`project.json` GETs ≤ N), not timings.
     - Command: `MARIMOHUB_BENCH=1 pnpm --filter @marimo-hub/core exec vp test projectList.bench`.
       Do **not** add a package script unless `vp test` cannot select the file.
   - Run it before Step 6 and after, and record both tables for Step 9.
8. **API filters and sort** (`packages/api/src/pagination.ts`,
   `packages/api/src/routes/projects.ts:153-172` and `:362-378`,
   `ProjectService.listProjects` filter type).
   - Tests in `packages/api/src/routes/projects.test.ts`, next to the
     existing filter tests at `:54-130`:
     - `owner=me` and `member=me` narrow, including with an email-invite row.
     - Each `sort`×`order` orders correctly with id tiebreaks on equal keys.
     - Paging `sort=name&limit=2` walks the whole set with no dups.
     - A default-sort cursor from before the change still decodes.
     - A `sort=name` cursor sent with `sort=created_at` → 400.
     - `owner=bob` → 400 (enum).
     - Omitting all new params reproduces today's response exactly.
   - `packages/api/src/pagination.test.ts`: direction-aware boundary.
   - `pnpm schemas:generate`, then commit the regenerated specs.
9. **Docs**: `docs/operations.md` "Scaling" (`:73`) with the measured table and
   ceilings; `docs/api.md:124-126` (sort, order, owner, member, cursor/sort
   rule); `development_docs/bucket_spec.md:1389-1394`;
   `development_docs/migrations.md` (after `:73`); the two-phase release note.
10. Review the diff and strip AI-slop comments: restatements, change
    narration, and obvious doc blocks. Keep the why-comments: the token
    protocol, the cross-check, the cache immutability, and the stale bound.

## Verification

- `pnpm --filter @marimo-hub/core test`
- `pnpm --filter @marimo-hub/api test`
- `pnpm --filter @marimo-hub/server test` (cron counts) and
  `pnpm --filter @marimo-hub/config test`
- `MARIMOHUB_BENCH=1 pnpm --filter @marimo-hub/core exec vp test projectList.bench`.
  Expect `project.json` GETs per list = 0 after Phase 2 for N=500 under both
  roles, and wall time dominated by one catalog GET.
- `pnpm schemas:generate`, then `git diff --stat` shows only the expected spec files.
- Root: `pnpm check && pnpm typecheck && pnpm test`, then `pnpm build`.
- Manual, `pnpm dev` with `MARIMOHUB_DEFAULT_ROLE=none`:
  1. Seed about 200 projects.
  2. Remove yourself from one. It disappears from `GET /api/v1/projects` on the
     next request.
  3. Demote yourself to `app-user` under `MARIMOHUB_DEFAULT_ROLE=editor`. The
     project disappears from the list and appears under `/apps`.
  4. `GET /api/v1/projects?sort=name&order=asc&member=me` pages correctly.

## STOP conditions

- **Any change that lets a snapshot-only decision grant MORE than `project.json`
  would.** For example: trusting `members` while a token is present, treating
  `undefined` from `projectEntryRole` as "no explicit row → default role",
  or skipping the cross-check. STOP and report. Every indeterminate path must
  fall back to the authoritative read.
- **Any write to `_system/catalog.json` or a snapshot object that does not go
  through `CatalogService.mutateSnapshot`**, including in the bench seed or the
  repair step. STOP.
- If the snapshot cache needs `mutateSnapshot` to read through it, or any
  caller is found mutating a returned snapshot and cannot be fixed locally,
  STOP and report. Ship the cache separately or not at all.
- If 068 has landed group rows outside `project.json` `members` without a fence,
  do not extend `projectEntryRole` to them. Return `undefined` for entries
  with such rows and report.
- If Phase 1 and Phase 2 cannot be separate releases (a release-process
  constraint), STOP and ask. Do not merge trust in the same release as the
  writer.
- If the token protocol cannot be expressed without changing
  `withCasRetry`/`mutateSnapshot` semantics, STOP. The design assumes both stay
  untouched.

## Follow-ups (out of scope)

- **Label pending race.** `security_labels_pending` is a boolean, so concurrent
  label mutations can clear each other's fence (A finalizes while B is parked;
  B crashes after its write). Port the same token list to labels
  (`setSecurityLabels`, `ProjectService.ts:437-523`, and the notebook
  equivalent).
- **Split `notebooks[]` out of the snapshot**, or shard per project, to remove
  the ~5 MB-per-write amplification at 500×20. This needs a two-phase snapshot
  shape change (`upgradeSnapshot`). It is the next ceiling after this plan.
- **`GET /apps`** (`packages/api/src/routes/apps.ts:100-120`) re-reads each
  project (`loadAppProject`) and lists its notebooks serially after
  `listProjects`. That path is O(N) reads by construction. Scope it with
  `project_id` or project the app catalog into the snapshot.
- Super-admin `owner=<user-id>` / `member=<user-id>` values.
- Web: 066 adopts `sort`/`order`/`owner=me`/`member=me` in the project list UI
  and widens `ProjectListFilters`.
