# App pools

Each notebook has an app pool that assigns accounts to versioned app sandboxes. Tabs and devices share one account assignment.
Capacity starts on demand and can reach zero. A new sandbox can consume a [warm pool](./warm_pools.md) member.

## Ownership and routing

`AppPoolStore` alone writes `_system/app-pools/{pid}/{nid}.json` through bucket CAS.
The record contains members, account assignments, visit leases, and a retained deletion tombstone.
`AppPoolRouter` makes pure routing decisions. `AppPoolService` coordinates persistence and session state.

1. Admission expires old presence and reads the committed notebook version.
2. An active account keeps its existing assignment, including an older version.
3. New accounts fill available members of the current version. Otherwise, admission reserves a member or returns busy.
4. The reservation persists before compute creation. Completion requires the current operation token and an unexpired reservation.

Member states are `starting`, `ready`, `draining`, and `retiring`.
New versions drain older members without moving their users. Starting reservations count toward capacity.
The service rechecks the source head during CAS retries and after new admission to reject concurrent version changes.

## Presence and recovery

Visit leases and reconnect grace protect assignments across tabs and brief disconnects. One account consumes one slot.
Empty members retire after the app idle timeout, subject to connection protection.
Retiring members remain recorded until sandbox reclamation succeeds.

Deletion retains the pool tombstone, so delayed requests cannot recreate it.
Legacy singleton sessions enter as drain-only members. A coordinated upgrade stops singleton writers before pool writers start.
Proxy requests check the account assignment. Direct kernel URLs bypass managed-page admission.

## Code

- [Router](../packages/core/src/services/runtime/AppPoolRouter.ts): capacity, versions, assignments, and presence.
- [Store](../packages/core/src/services/runtime/AppPoolStore.ts) and [service](../packages/core/src/services/runtime/AppPoolService.ts): CAS, reservation tokens, and recovery. Tests are colocated.
- [API integration](../packages/api/src/appPools.ts) and [session routes](../packages/api/src/routes/sessions.ts): admission, provisioning, and cleanup.

[Operator configuration and upgrade notes](../docs/app-pools.md)
