# App pool implementation

See [App pools](../docs/app-pools.md) for capacity, presence timers, API usage, and coordinated upgrades.
A new sandbox can consume a [warm pool](./warm_pools.md) member.

## Ownership and routing

`AppPoolStore` alone writes `_system/app-pools/{pid}/{nid}.json` through bucket CAS.
The record contains reservations, visit assignments, leases, and a retained deletion tombstone.
`AppPoolRouter` makes pure routing decisions. `AppPoolService` coordinates persistence, provisioning, and retirement.

1. Admission expires presence and reads the committed notebook version.
2. An existing `(user_id, visit_id)` keeps its assignment, including an older version.
3. New visits fill current-version members. Otherwise, admission reserves a member or returns busy.
4. The reservation persists before compute creation. Completion requires the current operation token and an unexpired reservation.
   A reservation lasts `max(startup timeout + 30 s, 15 min)`. Nothing renews it.
   The startup timeout is one deadline shared by Python-environment setup and the kernel-port wait. It does not bound cold boot, image pulls, or workspace restore.

Member states are `starting`, `ready`, `draining`, and `retiring`.
Retiring members remain recorded until sandbox reclamation succeeds.
Deletion retains a tombstone so delayed requests cannot recreate the pool.
Sweeps cache up to 10,000 empty tombstones by ETag. A changed or unavailable LIST ETag requires another record read.

Source and pool heads cannot share a CAS. Each CAS retry checks the committed source head.
New admissions and replacement retries check it again after CAS, before compute creation or admission completes.
Failed checks remove only the requesting operation's assignment or reservation. Existing visits remain intact.
Version IDs identify immutable content; their order does not determine publication order.

Legacy account assignments split into visit assignments before expiry or routing.
The visit ID remains stored during reconnect grace. Generation tokens reject stale heartbeats and departures after re-admission.

## Storage cost

| Operation                                         | Reads                                                         | Writes                                                 |
| ------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| Heartbeat                                         | One pool snapshot                                             | At most once per minute per visit with default timers. |
| Admission to an established pool                  | One pool snapshot, source head, one session record per member | Immediate CAS.                                         |
| New assignment, reservation, or replacement retry | One additional source-head check after admission CAS          | Compensation on failed checks.                         |
| Healthy maintenance pass                          | One pool snapshot, one session record per member              | None unless state changes.                             |
| Departure                                         | Pool snapshot                                                 | Immediate CAS.                                         |
| Proxy HTTP request or WebSocket upgrade           | Fresh pool snapshot                                           | None.                                                  |

Admission and maintenance reuse member observations across CAS retries.
Admission persists retirement changes separately, then rereads the pool before routing.
CAS conflicts reread the pool. Each admission retry also checks the source head.
No acknowledged lease renewal depends on an in-memory buffer surviving a server restart.
Proxy checks neither renew presence nor cache authorization across requests.

First admission discovers legacy sessions through a project-scoped scan.
Established admission does not list bucket objects. Session listings read each notebook's pool once, regardless of sandbox count.
Generic maintenance shares pool snapshots within each pass.
Operation-count tests cover these budgets, not remote bucket latency.

## Heartbeat scheduling

Project authorization and the initial session read overlap. Project failures take precedence without waiting for session storage.
The session promise handles rejection immediately, including after a project denial.
Notebook and preview checks precede attach authorization.
Session renewal reuses the initial session and ETag. Concurrent touches share one in-flight session mutation per service instance.
A write conflict rereads the session before retry.
The first due presence batch commits without the one-second delay. Later batches retain the one-second interval, including batches that arrive after the previous write finishes.
Every renewal waits for the persisted batch before acknowledgment. Each process batches its local callers.
The optional pool `last_presence_write_at` timestamp fences due renewal writes across replicas at one-second intervals.
CAS retries and waits recheck visit expiry and deletion. After five seconds of contention, the batch returns retryable HTTP 503 with `Retry-After: 2`.
Existing pool records need no migration. Rolling upgrades enforce the shared limit once all writers use this timestamp.
A coalesced heartbeat rereads the session to detect a concurrent stop or deletion without writing.
Response grants use the returned session.

A fresh unlabeled API heartbeat uses five metadata reads: project, notebook, pool, and two session reads.
Writable regular apps also read the source and editor claim to return `head_version_id` and `edit_active`.
It does not HEAD the catalog. Warm project and notebook reads use HEAD and reuse cached records when their ETags match.
`appPerformance.test.ts` asserts this seven-read budget.
A due heartbeat saves one session read and uses two conditional writes without conflicts. Identity I/O and policy calls are additional.
Denied projects incur one extra speculative session GET and no renewal writes.

### Measurements

Run the optional harness from the repository root:

```sh
mkdir -p "$PWD/.context"
APP_PERFORMANCE_REPORT="$PWD/.context/app-performance.json" \
  pnpm --filter @marimo-hub/api test src/appPerformance.test.ts
```

The harness records p50/p95, bucket operations, authentication, authorization, and policy-provider calls over two warm-ups and 20 samples per workload/profile.
Each sample starts with an admitted app. Concurrent samples use four service instances sharing one bucket.
Profiles inject 0 or 10 ms per metadata operation, plus one with 30 ms project reads and 10 ms per policy-provider call.
Identity I/O has no injected delay. Existing identity caches and first-request writes remain enabled.

Compute is simulated. Proxy samples measure authorization. Reconnect samples repeat admission for the same visit.
Real browser/kernel refresh and reconnect remain unvalidated. Ordinary CI has no latency thresholds.

## Code

- [Router](../packages/core/src/services/runtime/AppPoolRouter.ts): routing, presence, and occupancy.
- [Store](../packages/core/src/services/runtime/AppPoolStore.ts) and [service](../packages/core/src/services/runtime/AppPoolService.ts): CAS, operation tokens, and recovery.
- [API integration](../packages/api/src/appPools.ts) and [session routes](../packages/api/src/routes/sessions.ts): admission, provisioning, and cleanup.

Tests are colocated. [Storage ownership](./bucket_spec.md#app-pool-records) describes deletion and migration records.

Publish-time prewarming remains deferred until an explicit publish action exists. Creating or editing a notebook does not prewarm it. App visits retain on-demand admission and do not trigger extra prewarming.
