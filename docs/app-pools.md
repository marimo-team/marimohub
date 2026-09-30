# App pools

Each notebook has a pool of app sandboxes. Each browser tab has independent marimo kernel state and consumes one **visit slot**, even within the same account.
The router fills available sandboxes before starting more. An unused pool can scale to zero.

New visits receive the latest committed notebook version, including periodic editor saves.
Existing visits keep their sandbox and version until departure or expiry.

## Configuration

Configuration applies to every app in the deployment.

| Environment variable                     | Default | Purpose                                                                   |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------- |
| `MARIMOHUB_APP_MAX_VISITS_PER_SESSION`   | Unset   | Visit slots per sandbox.                                                  |
| `MARIMOHUB_APP_MAX_SESSIONS_PER_VERSION` | Unset   | Starting reservations and ready sandboxes per notebook's current version. |

Both settings accept positive integers. Unset means unlimited.
With `MARIMOHUB_APP_MAX_VISITS_PER_SESSION=2`, three tabs from one account use two sandboxes.
`MARIMOHUB_APP_MAX_USERS_PER_SESSION` is deprecated. It aliases to `MARIMOHUB_APP_MAX_VISITS_PER_SESSION` and logs a warning when used.
If both are set, `MARIMOHUB_APP_MAX_VISITS_PER_SESSION` takes precedence.

Starting reservations occupy capacity before compute starts.
Older versions drain and do not count toward the per-version limit. Expired starting reservations also stop counting while maintenance reclaims them.
Project and starter-user limits still count all physical sandboxes, including draining versions.
These limits can block a new version from starting. Full pools return HTTP 429 with `Retry-After`; the app page offers a retry action.

## Presence and departure

Each page sends a heartbeat every 30 seconds and a departure request on navigation or closure.
A persisted lease lasts 120 seconds. Heartbeats renew it at most once per minute, with at least 60 seconds of durable coverage.
Missed departures and browser crashes release slots through lease expiry.

Departure holds that visit's slot for 15 seconds of reconnect grace. Other tabs keep their own slots.
Re-admitting the same visit ID during grace preserves its assignment. A new page load creates a new visit.
After expiry, a visit must enter through admission again and receives the latest version.

Freeing a slot does not immediately retire its sandbox.
The idle clock starts at the last lease or grace deadline.
`MARIMOHUB_SESSION_APP_IDLE_TIMEOUT_SECONDS` controls retirement, subject to kernel connection protection and maintenance cadence.
It inherits `MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS` when unset, with a default of 1,800 seconds.
Fresh visit leases protect occupied sandboxes even with stale session heartbeats.
If a connection probe fails, maintenance also checks the last session heartbeat against the idle timeout.
Credential expiry and provider lifetime limits still apply.

## API and access

Independent API clients must supply distinct `app_visit_id` values. Retries reuse the same ID.
Use the returned `app_assignment` for heartbeats and departure.
Without an ID, callers share the legacy `api` visit for their account.
The response fields `users`, `max_users`, and `max_users_per_session` retain their names but count visit slots.

Proxy HTTP requests and WebSocket upgrades require an account assignment to the requested sandbox.
An account can have assignments to several sandboxes. Direct kernel URLs bypass managed-page admission.
Occupancy therefore measures managed page visits, not exact kernel connections.

## Versions and operations

Synced notebooks load their immutable version workspace.
Local notebooks load committed code and dependencies over existing auxiliary workspace files, which retain their mutable semantics.
A missing version file fails startup.

Notebook rows show each sandbox's version, pool state, and visit occupancy.
Stop and restart actions affect every visit on the selected sandbox.
Restart reserves a replacement on the current version, then reclaims the old sandbox before starting compute.
The replacement uses the selected sandbox's pool slot during teardown. Both remain recorded until reclamation finishes.
Repeated restart requests reuse the replacement. Assignments to other sandboxes remain unchanged.
Affected visits must enter through admission again. The hub does not transfer kernel memory or replay requests.

## Upgrade

Stop old server and maintenance replicas before upgrading. Do not mix singleton, account-based, and visit-based pool writers.
Existing sandbox processes can remain running.

Existing account assignments split into visit slots without moving live sessions or changing heartbeat tokens.
Sandboxes above the new limit keep their existing visits but accept no additional visits until space becomes available.
Old assignments already in reconnect grace retain one slot until expiry because their departed visit IDs were not stored.
Legacy singleton sessions enter as drain-only members and retain access through legacy heartbeats.

Run maintenance to recover interrupted provisioning and retry failed sandbox cleanup.
Pool records and deletion tombstones remain until reclamation finishes; empty deletion tombstones remain permanently.

## Storage cost

`app_pool_admission` records routing outcomes. `app_pool.visits` measures occupied visit slots.
Monitor `app_pool.cas.conflicts` and `app_pool.cas.exhausted` as traffic grows: each notebook uses one CAS record.
Its size grows with visits and sandbox members.
See [implementation and storage costs](https://github.com/marimo-team/marimohub/blob/main/development_docs/app_pools.md) for read/write budgets and ownership rules.
