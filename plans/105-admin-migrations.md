# Plan 105: Show automatic migration progress in Admin

## Status and starting point

- Status: IMPLEMENTED (2026-11-12). All required verification gates passed.
- Priority: P2. Effort: M–L. Risk: MED–HIGH.
- Baseline: `048ec41a9`, reviewed on 2026-11-12.
- Destination: `plans/105-admin-migrations.md`.

This revision replaces the attached plan and `.context/plan-105-revision.md`.
The automatic runner prerequisite is present. The earlier concurrency stop condition
is resolved by preserving the current dependency graph and backoff behavior.
No prerequisite merge or runner rewrite is required.

Preserve the branch name and unrelated edits. Do not commit, push, or open a PR
unless requested. Update this plan and `plans/README.md` after implementation.

### Resolved execution decisions

- `BackgroundMigration.after` declares dependencies. Omission means all earlier
  executable entries; `after: []` permits independent work.
- The registry includes `project-access-v1` and independent `session-index-v1`.
- A tick can attempt failed migrations before checkpointing one successful batch.
  It can rethrow an earlier error after independent work succeeds.
- Preserve process-local backoff: after three failures, 30 seconds doubling to
  ten minutes. Manual requests do not clear backoff or the completed cache.
- Inspection derives dependencies from the same normalized registry as execution.
  It does not change readiness, populate caches, or run batches.
- `refreshCompleted()` already performs request-isolate readiness reads.
  Preserve those reads; this feature adds no migration I/O to ordinary requests.

### Resolved host decisions

Node already runs migrations at startup and every five seconds with a 55-second
deadline. Worker `wrangler.jsonc` declares a five-minute cron, and its scheduled
handler invokes the same migration service. The request path provides invocation-local
`waitUntil` through `executionContext`.

Use a 20-second cancellation budget for HTTP-triggered Worker work. Cloudflare
allows up to 30 seconds of `waitUntil` work after response or disconnect, shared
with other registered work. The margin is not a completion guarantee. CPU and
other invocation limits still apply. Preserve leases and scheduled recovery if
Cloudflare terminates work before cancellation settles.

Sources checked on 2026-11-12:
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/) and
[execution context](https://developers.cloudflare.com/workers/runtime-apis/context/).
The checked-in cron is verified; live deployment configuration is not.
Describe Worker continuation as requiring the configured cron, never as verified
live scheduler health. Missing cron is an operator configuration issue, not a
reason to stop implementation of inspection or the bounded attempt.

Node's `DeferredWorkQueue.defer` currently falls back to inline execution on overflow.
Add a narrow `tryDefer(label, task): boolean` method that shares its admission logic
but rejects overflow without starting work. Preserve `defer` behavior for existing
callers. The migration callback uses `tryDefer` and rejects during shutdown or
saturation. Include `apps/server/src/backgroundWork.ts` and its tests in scope.

## Outcome

Add **Admin → Migrations**, available to session-authenticated super admins.
Normal upgrades remain automatic and require no shell, `pnpm`, or admin click.
The page explains what is running, saved progress, whether the app remains usable,
and what an administrator can do when work fails. Request attempt only nudge
the existing runner; they never reset a receipt or create another migration engine.

Make future additions cheap: one registry definition supplies execution and
display metadata. Implementing another migration should require its owner-service
batch, a registry entry, and tests—not another endpoint, page, or status mapping.

V1 includes counts, a table, expandable details, manual refresh, and run/retry
actions. It excludes rollback, pause/cancel, force-complete, editing cursors,
destructive repairs, arbitrary code execution, and an attempt-by-attempt history log.
Completed receipts provide completion history; repairs remain separate operations.

## Existing implementation and conventions

Paths below are relative to the repository root. The runner and host scheduling were checked in this workspace. Recheck the listed
integration points during implementation.

| File | Existing behavior / reuse |
| --- | --- |
| `packages/core/src/services/catalog/MigrationService.ts` | Owns `_system/migrations/{id}.json`; one batch per tick; process-local in-flight guard; dependency-aware registry order and backoff; 60-second lease; acquisition ETag fences progress and release; completed IDs cached. |
| `packages/core/src/services/catalog/migrations.ts` | Registers `project-access-v1` and independent `session-index-v1`; catches `NotInitializedError` and returns an unchanged cursor. |
| `packages/core/src/services/content/ProjectService.ts`, `migrateAccessSummaries` | Visits at most 25 projects in stable ID order through `CatalogService.mutateSnapshot`; preserves permission markers; metadata reads happen inside the catalog CAS callback. |
| `packages/core/src/services/index.ts` | Builds `services.migrations`; do not instantiate a second runner for the viewer. |
| `packages/core/src/specs/bucketSpec.ts` | Uses `MigrationStateSchema` to generate the stored-record specification. |
| `apps/server/src/cron.ts`, `startMigrations` | Immediate startup attempt, 5-second interval, 55-second deadline, shutdown cancellation, stops after completion. Independent of maintenance enablement. |
| `apps/server/src/backgroundLoops.ts` | Loop health, cancellation and draining; current `LoopHandle` exposes stop/drain, not an immediate-wake method. |
| `examples/cloudflare-worker/src/index.ts` | Scheduled handler runs `services.migrations.tick()` alongside other maintenance; request-scoped `waitUntil` registration is available through `executionContext` and `backgroundWork`. |
| `packages/api/src/routes/admin.ts` and `admin.runtime.test.ts` | Session-only admin routes, super-admin checks, Zod/OpenAPI contracts, safe projections, authorization tests. |
| `packages/api/src/context.ts`, `createApi.ts` | `ApiDeps` and route composition. |
| `packages/core/src/ports/backgroundWork.ts`, `packages/api/src/backgroundWork.ts` | Existing background work is best effort; some helpers deliberately fall back to inline execution. Do not use that fallback for a route promising immediate acceptance. |
| `packages/web/src/components/Admin/AdminLayout.tsx`, `packages/web/src/App.tsx` | Admin gate, tab list, lazy page routes. |
| `packages/web/src/components/Admin/AdminRuntimePage.tsx` and `.test.tsx` | Existing components, loading/error handling, API fixtures and polling tests. |
| `packages/web/src/api/hooks.ts`, `queryKeys.ts`, `packages/web/src/types/index.ts` | Typed generated client, query/mutation conventions and response aliases. |
| `development_docs/migrations.md` | Migration extension, retirement, at-least-once execution and rolling-upgrade policy. |

Current runner contract:

```ts
export interface MigrationContext {
	cursor?: string;
	signal?: AbortSignal;
}
export type MigrationBatch = { done: true } | { done: false; cursor?: string };
export interface BackgroundMigration {
	id: string;
	after?: readonly string[];
	runBatch(context: MigrationContext): Promise<MigrationBatch>;
}
```

The stored v1 variants currently contain only:

```ts
{ version: 1, status: 'pending', cursor?: string }
{ version: 1, status: 'running', cursor?: string, lease: string, expires_at: number }
{ version: 1, status: 'complete', completed_at: string }
```

`tick()` coalesces calls on the same instance. `advance()` respects declared
dependencies and backoff while visiting the registry in order. On unsuccessful execution its `finally` releases to the prior cursor using
the acquisition ETag. Do not weaken this behavior to add display fields.

Use inward dependencies: core defines storage behavior; API maps it to HTTP;
entrypoints own scheduling. No provider SDK imports in core/API. Match tabs,
single quotes, semicolons, existing UI primitives, Tailwind, React Router and
TanStack Query. Match the admin route guards:

```ts
assertSessionAuthenticated(c, 'inspect migrations');
await assertSuperAdmin(c.get('user'), deps);
```

The API envelope is `{ success: true, data }` / `{ success: false, error }`.
Generate committed schemas and client types; do not hand-edit generated files.

## Decisions to preserve

### Registry and history

Extend registry definitions with `title`, `description`, `impact`, and optional
`progressUnit`. Example title: “Speed up project access checks”; impact: “The app
stays available. Access checks use existing metadata until summaries are ready.”
Keep text in the registry, not in UI ID-specific conditionals.

Add a descriptor-only retired registry alongside executable definitions. Retiring
a migration removes its executable batch but retains its descriptor and receipt.
Validate IDs across both registries. The viewer reads those known keys directly;
it never lists the bucket to discover historical IDs. Remove retired IDs from executable dependency declarations; validate that no stale
explicit dependency remains. Retirement must retain safe fallback behavior for
installations without that receipt. Missing retired receipts
mean “Not recorded”, not pending work or a failed upgrade. Retired rows are a
separate history section and excluded from active counts and dependency checks.
Unknown receipt IDs stay untouched. Complete historical coverage of unknown IDs
would need another design; do not add a storage scan to this feature.

### Saved telemetry, compatible with existing records

Keep storage `version: 1` and the three existing status variants. Add optional
fields for first start, last attempt, last successful checkpoint/progress time,
attempt count, progress, waiting reason, and a bounded safe failure object.
Completion retains available telemetry alongside `completed_at`. Old receipts
remain valid and are never rewritten just to populate the page.

All updates go through `MigrationService` and its existing lease/CAS writes.
Record an attempt only on successful lease acquisition. Publish batch progress
with the cursor/receipt in the same conditional write. Record failures only if
that attempt still owns the acquisition ETag. A failed release cannot replace
the original exception; telemetry must not turn uncertain completion into replay.

Existing older writers reconstruct these objects and can discard optional fields.
Therefore telemetry is best effort during a rolling deploy: absent counts/times
display as unavailable, never as proof of no attempts or no failures. Preserve
unknown additive fields in new read-modify-write paths, but never carry a lease
into pending/complete state. Do not introduce new execution states or scheduling
dependencies on telemetry that older writers do not understand.

Extend batch results with optional progress and an explicit waiting reason.
`waiting_for_initialization` replaces inference from an unchanged cursor; it is
not an error, does not initialize the catalog, and does not count as progress.
Use a **committed batch delta** for visited items, added by the runner only when
the checkpoint CAS succeeds. Compute the delta afresh inside each catalog CAS
attempt, rather than incrementing an outer counter on every retry. Include the
last batch's delta in completion. “Visited” includes already-current and skipped
entries; it does not claim every permission marker was resolved.

For resumed legacy records with a cursor but no counter, mark coverage as partial
and label “N visited since tracking began”; do not backfill counts by scanning.
Fresh executions can report cumulative visited counts. Do not claim an exact
unique-item count under arbitrary concurrent domain changes. The project-access
migration has no stable total, so show a count and activity indicator, not a
percentage. A future migration may supply a total only for a fixed work set;
reject invalid negative/non-integer counts and totals below processed counts.

Persist only allowlisted error codes and fixed, operator-friendly messages.
Never put raw exception text, stack traces, provider responses, cursor values,
lease tokens, credentials, or resource paths into failure telemetry or API
responses. Internal checkpoints still retain their required cursor and lease. Example categories:
`storage_unavailable`, `invalid_source_data`, `migration_failed`. Unknown failures
get generic text and a timestamp; operators use server logs for diagnosis.
Shutdown cancellation is not an operator failure. A batch timeout can be reported
as retryable without allowing overlapping execution.

### Read model and status

Add a read-only `MigrationService.inspect()` that reads one object per known ID
with bounded concurrency and returns safe summaries plus `observed_at` and an
`incomplete` flag. Reuse each read for counts and details. Do not use the runner's
completed-ID cache as a complete UI record, or mutate that cache during inspection.

| Condition | UI state | Action / attention |
| --- | --- | --- |
| No record or pending without failure | Waiting | Covered by page-level request when eligible |
| Pending with explicit initialization reason | Waiting for initialization | No action needed |
| Declared prerequisite unfinished | Waiting for prerequisite | Show dependency; cannot skip it |
| Valid running lease | Running | No competing run; show last saved progress |
| Expired lease | Waiting to resume | Eligible for normal takeover; not automatically an error |
| Saved retryable failure | Retrying | Covered by page-level request; needs-attention count |
| Corrupt or unsupported state version | Blocked | Needs attention; no reset/retry button |
| Valid receipt | Completed | No run action |
| Individual storage read failure | Status unavailable | Mark response incomplete; no guessed completion or safe action |

Status precedence: unreadable/corrupt state first, valid complete receipt next,
then live lease, then dependency wait, then initialization/failure/pending state.
Retain failure details on dependent waiting rows if present. Use four mutually
exclusive summary buckets: waiting, running, completed, needs attention.
Retrying and blocked rows contribute to needs attention; dependency-waiting rows
contribute to waiting. A running retry may retain last failure details but belongs
to running, not two summary buckets. The attention badge uses the needs-attention
count. Unknown rows are excluded from authoritative counts; mark counts incomplete.

A malformed known checkpoint blocks that row and dependent execution without
breaking display of other rows. Do not overwrite it to save a failure message.
Expose only the safe reason, not parser diagnostics. No GET performs writes,
domain scans, catalog initialization, or migration batches.

### Run/Retry semantics and host lifetime

Use a single action endpoint: `POST /api/v1/admin/migrations/run`, with no arbitrary
migration ID or cursor. One page-level “Request attempt” button invokes the existing runner.
It does not target a row or promise an immediate retry. Rows identify their actual
unfinished prerequisites. Independent migrations remain eligible beside failed,
corrupt, leased, or backed-off rows. Treat POST as a nudge, not
an exactly-once command: repeated calls may advance subsequent bounded batches,
but must never duplicate leased work or bypass dependencies or backoff.

Add an optional, purpose-specific host callback to `ApiDeps`, for example
`requestMigrationTick(): Promise<void>`. Its promise resolves when one bounded
attempt has been registered with the host, not when migration completes. API
handlers do not run batches themselves. Hosts without the callback advertise
actions unavailable and return 503 for POST, rather than silently running inline.

- Node: register the attempt with `DeferredWorkQueue`, using the same
  `services.migrations` instance, shutdown signal and 55-second deadline policy as
  automatic work. Extract a shared bounded-attempt helper if necessary. Keep
  automatic loop health accurate. Never release the in-flight guard merely
  because a deadline fired while underlying work is still settling.
- Worker: register one bounded attempt with the current invocation's `waitUntil`.
  Use the 20-second cancellation budget established above. Reject a missing
  invocation context before creating any work promise. Scheduled ticks remain the continuation mechanism. Do not run
  an unbounded loop or recursively extend `waitUntil` to finish the whole migration.
- Neither callback creates durable delivery. Pending checkpoints plus startup/
  scheduled attempts provide recovery if the accepted nudge is lost on process
  death. State this accurately in API docs and UI: “Attempt requested. Automatic continuation requires the host scheduler.” Do not display “Queued” as a durable guarantee.
- Closing the browser does not cancel registered work. Repeated clicks, two
  administrators, and a simultaneous scheduled attempt share process guards and
  storage leases. No force-stealing an unexpired lease.
- A receipt stays complete even if an administrator retries from a stale page.
  Do not clear the completed set, remove receipts, or expose the repair command.

GET `/api/v1/admin/migrations` returns registry metadata, rows, counts,
`observed_at`, `incomplete`, and host action availability. Derive page-level request eligibility from readable
unfinished rows and their declared dependencies, excluding retired rows. Do not
expose process-local backoff as a durable eligibility guarantee. POST returns 202 only
after successful registration, 200 with `already_complete` when known complete,
409 when invalid checkpoints block all remaining executable work, and 503 when
state or scheduling is unavailable. A corrupt independent row cannot veto healthy
independent work. If a safe candidate is readable despite other failed reads, allow
registration and retain the incomplete flag. If eligibility cannot be established,
return 503. Live leases or backoff can make an accepted nudge a no-op.
A race after inspection is expected: the runner rechecks durable state and may
find nothing to do. Reject extra request fields. Both endpoints require session
authentication and super-admin authorization before reading migration storage.
Use existing audit conventions for operator-triggered attempts; omit raw failures.

Do not invent a precise `next_retry_at`: current retries are host-driven, with
different Node and Worker cadences. Show “Retries automatically” and, when the
host explicitly supplies its cadence, an approximate cadence. A Worker without
cron must be described as needing scheduled-handler configuration, not healthy
automatic continuation; the action must not promise completion in that setup.

## Implementation sequence

### 1. Add metadata, telemetry and inspection in core

Modify `MigrationService.ts`, `migrations.ts`, their colocated tests,
`ProjectService.ts`, `ProjectService.accessRebuild.test.ts`, and service wiring
only as required for descriptors. Add a focused `migrationInspection.ts` helper
and `.test.ts` if projection logic merits separation; the service still owns I/O.
Implement the contracts and compatibility rules above. Return progress from the
actual bounded batch; do not create a second project traversal for the viewer.

Verify: `pnpm --filter @marimo-hub/core test run MigrationService migrations ProjectService.accessRebuild`
passes; include inspection tests in the filter if using the separate file.

### 2. Add the admin API and host scheduling callback

Create `packages/api/src/routes/migrations.ts` and `migrations.test.ts`; mount it
alongside admin routes in `createApi.ts`. Define explicit safe response schemas
and stable operation IDs `admin.migrations.list` / `admin.migrations.run`.
Add the optional callback to `context.ts`, then wire it in
`apps/server/src/bootstrap.ts` and `examples/cloudflare-worker/src/index.ts`.
Use `apps/server/src/cron.ts` and a focused helper such as
`apps/server/src/migrationControl.ts` for shared timeout/shutdown behavior;
avoid a broad rewrite of `BackgroundLoops` or the general background-work port.

Extend `apps/server/src/migrations.test.ts`, relevant bootstrap tests, and Worker
`index.test.ts`. Generate schemas/client artifacts before writing typed UI calls.

Verify each exits 0:

```sh
pnpm --filter @marimo-hub/api test run migrations admin
pnpm --filter @marimo-hub/server test run migrations bootstrap
pnpm --filter @marimo-hub/example-cloudflare-worker test run src/index.test.ts
pnpm schemas:generate
pnpm typecheck
```

### 3. Build the registry-driven admin page

Create `packages/web/src/components/Admin/AdminMigrationsPage.tsx` and its test.
Add the tab in `AdminLayout.tsx`, lazy route in `App.tsx`, `adminKeys.migrations()`,
query/mutation hooks and generated-response aliases in the existing API/type files.

- Heading and short explanation that migrations run automatically.
- Summary counts, table with name/status/progress/last progress/action, expandable
  details for ID, description, impact, attempt information and safe failure.
- Completed history stays visible; retired descriptors live in the history section.
- One page-level request action; disable while the mutation is pending. Use backend capabilities and eligibility, not only client status. Keep one
  mutation and invalidation path; row details do not promise targeted execution.
- Loading, empty registry, unknown legacy progress, partial read failure, API error,
  successful acceptance, conflicting/stale action and forbidden response states.
- Poll every five seconds only while the page is mounted and visible and active
  work remains. Use query-owned polling, `refetchIntervalInBackground: false`,
  refetch on focus/reconnect, and manual refresh. Stop polling when only completed, retired, blocked, or blocked-dependent rows
  remain. Keep polling for independent work beside blocked rows. Query failures must back off rather
  than create a tight retry loop. No page-level `setInterval` or effect-derived counts.
- If an attention badge appears on the Migrations tab, use cached page data; do
  not mount a new polling query in global navigation. Routine work gets no badge.
- Use status text in addition to color, accessible disclosure controls, readable
  narrow layouts, and existing `PageContainer`, `PageHeader`, `Button`, `Chip`,
  time helpers and notification conventions.

Verify: `pnpm --filter @marimo-hub/web test run AdminMigrationsPage` and
`pnpm typecheck` pass. Inspect the page at desktop and mobile widths using seeded
test data for pending, retrying, unknown and completed states. Save screenshots
under `.context/` if using browser verification.

### 4. Document and run the full gates

Update `development_docs/migrations.md` with the UI, action semantics, missing
telemetry, scheduler requirements, descriptor retirement, and a copyable recipe
for adding a migration. Update the migration section in
`development_docs/bucket_spec.md` and relevant admin/operator docs. Keep generated
`packages/api/openapi.yaml`, `internal/schemas/bucket.yml`, client outputs and
CLI manifest changes consistent with `pnpm schemas:generate`.

The extension recipe must demonstrate: permanent ID; plain-language metadata;
bounded owner-service batch; optional committed progress delta; cancellation;
safe fallback before completion; tests for replay/concurrency; retirement that
retains descriptors/receipts. Adding a fixture migration should demonstrate that
the viewer needs no ID-specific code.

Verify the full gates below. Inspect the diff for unexpected generated changes
and preserve unrelated working-tree changes. Update the plan/index status.

**Final to-do: review all changes and strip AI-slop comments.** Keep comments
only for non-obvious reasons, invariants or gotchas; remove narration and obvious
signature restatements. This planning change adds no source comments.

## Required tests

Extend the existing fake-time/MemoryBucket tests rather than writing tests that
only repeat field assignments. Use `@marimo-hub/core/testing/memory-bucket` in API
tests and existing `createTestApi` / `renderWithClient` helpers.

| Area | Required cases |
| --- | --- |
| Compatibility | All old v1 variants parse; legacy complete remains complete with unknown counts; old running cursor gets partial progress; unknown extra fields preserved by new writes; older-style write drops telemetry without breaking execution; future versions remain untouched. |
| Progress | Multi-batch restart; final batch included; failed batch does not increment; catalog CAS retries do not multiply counters; lost checkpoint response after commit; stale worker cannot regress progress; no-init wait makes no progress; empty catalog; partial counters clearly labeled. |
| Failures | Safe messages for thrown strings, nested/provider errors and secret-looking input; failure-write outage preserves original error; corrupt JSON and invalid version; shutdown versus timeout; inspection succeeds partially when one key fails. |
| Execution | Two replicas and two clicks; scheduled tick races manual nudge; live lease not stolen; expired lease takeover; late publish/release fenced; complete receipt never resets; dependency order not skipped; unknown IDs cannot be submitted. |
| Host lifetime | API returns before batch resolves; closing browser irrelevant; Node shutdown cancels/drains; timeout does not overlap stalled work; Worker registers with request invocation; scheduled continuation after dropped nudge; missing callback returns unavailable. |
| Authorization | Anonymous 401; non-super-admin 403; super-admin PAT/service-account credentials rejected by session-only guard; rejected callers do zero migration reads/writes/work. |
| Cost | GET reads only known migration keys once per row with bounded concurrency; no bucket listing, project metadata, catalog scans, batch execution or writes. Ordinary requests retain their existing readiness-refresh I/O only. Completed automatic runner retains zero recurring I/O. |
| UI | Counts/status precedence; incomplete data not shown as all complete; history/retired rows; no bogus percent; request action invalidates query; disabled duplicate action; stale 409/503 handling; polling stops on unmount/hidden/completion; refresh/focus works; keyboard controls and text status. |
| Extensibility | Register an additional synthetic definition with different unit/metadata; it appears and runs in order without editing API/UI ID mappings; retirement preserves receipt/history and removes execution. |

Existing regression suites to preserve include
`MigrationService.test.ts`, `migrations.test.ts`,
`ProjectService.accessGeneration.test.ts`, `ProjectService.accessRebuild.test.ts`,
`apps/server/src/migrations.test.ts`, and endpoint storage-cost snapshots.

## Verification and done criteria

Commands are from the repository scripts; installation is only needed if dependencies
are absent. They are executor gates, not commands run while writing this plan.

| Purpose | Command | Required result |
| --- | --- | --- |
| Install if needed | `pnpm install --frozen-lockfile` | Exit 0 |
| Generated contracts | `pnpm schemas:generate` | Exit 0; only expected generated diffs |
| Formatting/lint | `pnpm check` | Exit 0 |
| Typecheck | `pnpm typecheck` | Exit 0 |
| Full tests | `pnpm test` | All pass |
| Storage-cost regression | `pnpm test:perf` | Pass without unrelated snapshot updates |
| Build | `pnpm build` | Exit 0 |

- [x] Gates pass and new tests cover the table above.
- [x] UI/API work in Node and Worker compositions; no shell access needed.
- [x] Existing stored records require no migration/reset; completed work never replays.
- [x] Safe failure details and history survive restart when telemetry is present.
- [x] Only admin inspection/action paths add migration I/O; existing readiness refresh remains unchanged.
- [x] A new registry definition automatically appears without UI/API changes.
- [x] No source edits outside the stated core, API, host, UI, docs and generated
  integration points; no adapter, authorization-policy or unrelated maintenance changes.
- [x] Plan/index updated; final comment review complete.

## Boundaries and acceptance gates

The prerequisite and concurrency review is complete. Proceed with implementation
against the decisions above. Routine drift, missing telemetry, disabled actions,
queue saturation, and absent deployment cron use the documented fallback behavior.
They do not require another planning stop.

Escalate only if implementation cannot preserve lease/CAS ownership, permanent
receipts, session-only authorization, or the existing checkpoint version. Do not
weaken those invariants to make a test pass. Guaranteed delivery, rollback, repair,
live logs, per-attempt history, arbitrary receipt discovery, and a generic jobs
framework remain out of scope.

Writers predating `access_pending` still must stop before the project-access upgrade.
The viewer does not establish writer safety.

## Shared logic and additional failure tests

Reuse normalized dependencies in core execution and inspection. Compute safe row
statuses and counts once; API and UI must not reconstruct eligibility. Keep metadata
in the registry and all telemetry writes in `MigrationService`. Share Node deadline
and shutdown handling across automatic and requested attempts. Keep host-specific
registration in each entrypoint. Avoid new abstractions for single-use code.

Add these cases to the required matrix above:

- Independent progress beside failed, corrupt, leased, and backed-off migrations.
- Earlier failure plus later successful checkpoint in one tick: retain both progress
  and the original host-visible error.
- Manual request during backoff: no reset, lease stealing, or targeted-run promise.
- Missing Worker context, shared invocation limits, and dropped accepted nudges:
  no inline work; scheduled attempts recover from the saved checkpoint.
- Node queue saturation and shutdown: registration returns unavailable without
  starting work; existing `defer` callers retain their overflow behavior.
- Unavailable prerequisite beside readable independent work: safe action remains
  possible without guessed completion or complete counts.
- Retirement with stale explicit dependencies: reject the registry definition.
- Unknown fields, lost write responses, stale releases, and failure-write outages:
  retain the original failure and prevent progress regression.

Final task: review the complete diff and remove unnecessary comments. Update plan
status only after implementation and all required verification pass.

## Implementation verification

Implemented telemetry, dependency-aware inspection, session-only admin endpoints,
Node queue admission, Worker invocation registration, and the responsive admin page.
Schema generation, `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm test:perf`,
and `pnpm build` passed. Desktop and 390px mobile screenshots use seeded states;
the mobile page has no horizontal overflow.

The final review removed no necessary invariant comments. Configuration-document
drift exposed by the full suite required regeneration, which removed one obsolete
upgrade paragraph. No adapter or authorization-policy behavior changed.
