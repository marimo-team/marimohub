# App pools

Each notebook has an app pool. The pool routes a signed-in account to one sandbox across its tabs and devices.
New accounts receive the latest committed notebook version. Existing accounts keep their sandbox while their visits remain active.
Periodic editor saves also create eligible versions. A version starts a sandbox only when an account needs it.

## Configuration

Configuration applies to every app in the deployment.

| Environment variable                     | Default | Purpose                                                                 |
| ---------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `MARIMOHUB_APP_MAX_USERS_PER_SESSION`    | Unset   | Maximum distinct accounts in one sandbox. Unset means unlimited.        |
| `MARIMOHUB_APP_MAX_SESSIONS_PER_VERSION` | Unset   | Maximum starting or ready sandboxes for one notebook's current version. |

Both capacity settings accept positive integers.
For example, set `MARIMOHUB_APP_MAX_USERS_PER_SESSION=4` to expand after four accounts join a sandbox.

Apps use the existing `MARIMOHUB_SESSION_APP_IDLE_TIMEOUT_SECONDS` for empty-sandbox retirement.
When unset, it inherits `MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS`, which defaults to 1,800 seconds.
The idle clock starts when the last live account assignment expires, including reconnect grace.
Connection protection can delay retirement. Set the app idle timeout to `60` explicitly to opt into faster cleanup.

The router fills available sandboxes before it starts more. Starting sandboxes reserve account slots too.
There is no minimum warm pool. An unused app can scale to zero.

Older versions drain and do not count toward `MARIMOHUB_APP_MAX_SESSIONS_PER_VERSION`.
Repeated releases can keep several older versions alive.
`MARIMOHUB_MAX_APPS_PER_PROJECT` and `MARIMOHUB_MAX_SESSIONS_PER_USER` still count physical app sandboxes, including draining versions.
These safeguards can prevent a new version from starting. The API then returns HTTP 429 with `Retry-After`.
The app page shows a busy message with a retry action.

## Presence and departure

Each app page uses the heartbeat cadence returned by the API, currently 30 seconds.
Presence leases and reconnect grace are internal timers. Freeing an account slot and retiring an empty sandbox are separate decisions.
Multiple visits by one account consume one slot. Closing one tab does not release the other tabs.
The page sends a departure request on navigation or closure. Lease expiry handles missed departure requests and browser crashes.
Reopening during reconnect grace preserves the assignment.
After expiry, the account must enter through app admission again and receives the latest version.

Kernel connection probes protect sandboxes whose users remain connected after page heartbeats stop.
When a probe fails, the last session heartbeat provides an additional idle-timeout check.
Maintenance cadence adds delay to physical sandbox cleanup. Admission expires logical slots immediately.
Credential expiry and provider lifetime limits still apply.

Both direct sandbox exposure and authenticated proxy exposure support pooling.
Proxy admission checks the account assignment for HTTP requests and WebSocket upgrades.
Direct kernel URLs bypass managed-page admission. Occupancy measures managed account visits, not exact kernel connections.
A failed sandbox requires re-admission. The router does not transfer kernel memory or replay requests on another sandbox.

## Versions and operations

Synced notebooks load their immutable version workspace.
Local notebooks load committed code and dependencies over the existing auxiliary workspace files.
Local auxiliary files retain their existing mutable semantics. A missing version file fails startup.

Notebook rows show each sandbox separately, with its version, pool state, and account occupancy.
Stop and restart actions affect the selected sandbox and its connected users.
Restarting a sandbox from the notebook list creates its replacement on the current committed version.
It does not change an operator's assignment to another sandbox. Repeated requests for the same stopped sandbox reuse its live replacement.
Affected accounts must enter through admission again.
A version notice explains that new users receive the latest version. It does not require restarting occupied older sandboxes.

## Storage cost

Running app pages combine presence and status in one request every 30 seconds.
A heartbeat reads the pool once. It renews the durable visit lease at most once per minute with the default timers.
Other expired visits can require an earlier cleanup write. Concurrent writers can also cause CAS retries.
Admission and explicit departure persist immediately.

A persisted visit lease lasts 120 seconds. Renewal leaves at least 60 seconds of durable coverage.
Coalesced heartbeats do not extend that deadline until the next persisted renewal.
No acknowledged renewal depends on an in-memory buffer surviving a server restart.

An established pool's admission reads three pool snapshots, the committed source head, and one session record per member, without listing bucket objects.
Each CAS retry rechecks the head. Version IDs identify immutable content; their order does not determine publication order.
A healthy maintenance pass reads two pool snapshots and one session record per member. It does not rewrite unchanged state.
First admission discovers legacy sessions through a project-scoped scan.
Session listings read each notebook's pool once, regardless of its sandbox count.
Generic maintenance shares pool snapshots within each pass.

Proxy HTTP requests and WebSocket upgrades each require a fresh pool read to enforce assignments.
These checks do not write presence or cache authorization across requests.

The pool remains one CAS object per notebook. Its size grows with account visits and sandbox members.
Large, busy pools can therefore increase transferred bytes and CAS contention even when request counts remain bounded.
Monitor `app_pool.cas.conflicts` and `app_pool.cas.exhausted` before increasing traffic.
Operation-count tests cover these budgets; they do not measure remote bucket latency.

## Upgrade

Stop old application replicas before starting replicas with app pooling. Do not run singleton writers and pool writers together.
Existing sandbox processes can remain running during this coordinated application rollout.
The new application adopts legacy sessions as drain-only members.
Their existing clients retain access and can register presence through legacy heartbeats.
New arrivals enter the new pool. Legacy claims are released through `SessionService` when their sessions retire.

Run maintenance to recover interrupted provisioning and finish sandbox cleanup.
The pool stores reservations before compute creation and rejects completion after a reservation expires.
Cleanup keeps a retiring member until sandbox reclamation succeeds, so a later sweep can retry failed destruction.

The `app_pool_admission` event records routing outcomes. Metrics include admission decisions, CAS conflicts, provisioning, account occupancy, and drain completion.
