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

## Code

- [Router](../packages/core/src/services/runtime/AppPoolRouter.ts): routing, presence, and occupancy.
- [Store](../packages/core/src/services/runtime/AppPoolStore.ts) and [service](../packages/core/src/services/runtime/AppPoolService.ts): CAS, operation tokens, and recovery.
- [API integration](../packages/api/src/appPools.ts) and [session routes](../packages/api/src/routes/sessions.ts): admission, provisioning, and cleanup.

Tests are colocated. [Storage ownership](./bucket_spec.md#app-pool-records) describes deletion and migration records.
