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

Member states are `starting`, `ready`, `draining`, and `retiring`.
Retiring members remain recorded until sandbox reclamation succeeds.
Deletion retains a tombstone so delayed requests cannot recreate the pool.

Source and pool heads cannot share a CAS. Each CAS retry checks the committed source head.
New admissions and replacement retries check it again after CAS, before compute creation or admission completes.
Failed checks remove only the requesting operation's assignment or reservation. Existing visits remain intact.
Version IDs identify immutable content; their order does not determine publication order.

Legacy account assignments split into visit assignments before expiry or routing.
The visit ID remains stored during reconnect grace. Generation tokens reject stale heartbeats and departures after re-admission.

## Storage cost

| Operation                                         | Reads                                                            | Writes                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| Heartbeat                                         | One pool snapshot                                                | At most once per minute per visit with default timers. |
| Admission to an established pool                  | Three pool snapshots, source head, one session record per member | Immediate CAS.                                         |
| New assignment, reservation, or replacement retry | One additional source-head check after admission CAS             | Compensation on failed checks.                         |
| Healthy maintenance pass                          | Two pool snapshots, one session record per member                | None unless state changes.                             |
| Departure                                         | Pool snapshot                                                    | Immediate CAS.                                         |
| Proxy HTTP request or WebSocket upgrade           | Fresh pool snapshot                                              | None.                                                  |

Expired visits can require earlier cleanup writes. CAS conflicts add retries.
No acknowledged lease renewal depends on an in-memory buffer surviving a server restart.
Proxy checks neither renew presence nor cache authorization across requests.

First admission discovers legacy sessions through a project-scoped scan.
Established admission does not list bucket objects. Session listings read each notebook's pool once, regardless of sandbox count.
Generic maintenance shares pool snapshots within each pass.
Operation-count tests cover these budgets, not remote bucket latency.

## Heartbeat scheduling

The heartbeat handler starts its session read while it loads and authorizes the project.
It consumes the project result first, so project denials retain precedence and do not wait for session storage.
The speculative session read handles rejection immediately, even if the project gate returns first.

Notebook scope, preview liveness, notebook visibility, and attach authorization retain their order.
Pool renewal still uses `AppPoolService.heartbeat`. Session renewal still rereads the record through `SessionService.heartbeat` and its CAS retries.
Response grants use the updated session. Neither renewal can restore a departed visit or terminated session.

The storage-cost table counts pool operations only. The API harness also counts catalog, project, notebook, and session operations.
A fresh heartbeat uses six metadata operations: a catalog HEAD, project GET, initial session GET, notebook GET, pool GET, and session mutation GET.
A due heartbeat adds two conditional writes without conflicts. Identity I/O and policy-provider calls add separate costs.
Project denials add one speculative session GET compared with the serial handler, but no renewal writes.

The built-in UI already sends periodic heartbeats. This scheduling change does not reduce the number of client requests.
It needs no API change, capability negotiation, lease change, or coordinated client upgrade.
Reverting the handler scheduling does not require a client change.

### Measured result

A local macOS arm64 run with Node 24.21.0 measured the following results on 2026-10-14.
The remote profile injected 10 ms per metadata operation. Counts did not change on successful heartbeat requests.

| Workload                       | Serial p50 / p95 (ms) | Overlapped p50 / p95 (ms) |
| ------------------------------ | --------------------: | ------------------------: |
| Fresh heartbeat                |           66.9 / 67.6 |               56.0 / 56.4 |
| Due heartbeat                  |           89.3 / 90.5 |               77.9 / 79.0 |
| Four concurrent due heartbeats |         121.1 / 123.7 |             109.5 / 114.0 |
| HTTP proxy authorization       |           33.3 / 34.0 |               33.3 / 33.7 |
| Existing-visit admission       |         111.6 / 113.2 |             111.1 / 112.1 |

The slow-project/policy profile reduced fresh heartbeat p50 from 173.0 ms to 163.6 ms.
The in-memory profile showed no meaningful improvement. Proxy scheduling and client behavior remain unchanged.
No external gateway or real-kernel deployment was available for validation.
These measurements establish a heartbeat scheduling improvement only.

### Reproduce measurements

From the repository root, run:

```sh
APP_PERFORMANCE_REPORT="$PWD/.context/app-performance.json" \
  pnpm --filter @marimo-hub/api test src/appPerformance.test.ts
```

The optional harness reports p50/p95, operation counts, authentication calls, authorization calls, subject-context calls, and constraint calls.
It uses two warm-ups and 20 samples per workload and latency profile.
Each sample creates an admitted app before measurement. Concurrent samples use four service instances over one bucket.
The profiles inject 0 or 10 ms per metadata operation, plus a profile with 30 ms project reads and 10 ms per policy-provider call.
Identity operations have no injected delay. Existing identity caches and first-request identity writes remain part of the measured behavior.

Compute is simulated. Proxy samples measure HTTP and WebSocket authorization only. Reconnect samples measure repeated admission for an existing visit.
These results do not measure browser refresh, kernel forwarding, or a real WebSocket connection.
Ordinary CI runs deterministic operation and scheduling assertions without latency thresholds.

## Code

- [Router](../packages/core/src/services/runtime/AppPoolRouter.ts): routing, presence, and occupancy.
- [Store](../packages/core/src/services/runtime/AppPoolStore.ts) and [service](../packages/core/src/services/runtime/AppPoolService.ts): CAS, operation tokens, and recovery.
- [API integration](../packages/api/src/appPools.ts) and [session routes](../packages/api/src/routes/sessions.ts): admission, provisioning, and cleanup.

Tests are colocated. [Storage ownership](./bucket_spec.md#app-pool-records) describes deletion and migration records.
