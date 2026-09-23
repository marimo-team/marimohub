# Warm pools

Warm pools keep booted, unassigned sandboxes ready for editor and app sessions. Capacity is deployment-wide, per compute profile, and opt-in.
Notebook files, credentials, and kernels load after assignment.

## Ownership and lifecycle

`WarmPoolStore` alone writes `_system/warm-pools/{backend}.json` through bucket CAS.
`WarmPoolService` manages `creating`, `ready`, `claimed`, and `retiring` members.

1. Maintenance persists creation reservations before provider calls. Creating and ready members count toward the target.
2. A sandbox becomes ready after `ready()` and a bounded command probe succeed.
3. A claim records its destination and changes its operation token. Strict reconnect and another command probe precede acceptance.
4. Handoff checks the token and deadline before notebook data or credentials enter the sandbox. If the claim expires, the session uses cold creation with a new sandbox ID.
5. Session teardown owns assigned sandboxes. Claims never return to the pool. Failed cleanup retains ownership for retry.

Maintenance runs every five seconds under its own lease. Idle members rotate after at most 30 minutes, sooner for limited provider lifetimes.
Disabling pooling drains unassigned members. Unreadable ownership blocks orphan deletion.

## Provider boundary

`SandboxProvider.warmPool` declares the lifetime limit and additional creation inputs. `connectExisting()` must never create a replacement.
Configuration fingerprints include the image, profile, provider inputs, and deployment configuration.
CoreWeave and Kubernetes are the initial built-ins. Shared lifecycle code has no backend allowlist. See the [provider contract](./ports.md#warm-pool-support).

Jobs, diagnostics, non-default images, home mounts, and snapshot restores bypass pooling. Empty or unhealthy pools fall back to cold creation.
For [app pools](./app_pools.md), `bindWarmSandbox()` changes the unstarted reservation under its existing operation token.

## Code

- [Store](../packages/core/src/services/runtime/WarmPoolStore.ts) and [service](../packages/core/src/services/runtime/WarmPoolService.ts): durable ownership and lifecycle. Tests are colocated.
- [Configuration](../packages/config/src/warmPool.ts): eligibility, lifetime allowance, and fingerprints.
- [Session routes](../packages/api/src/routes/sessions.ts): allocation and handoff. [Server maintenance](../apps/server/src/cron.ts): replenishment.

[Operator configuration](../docs/warm-pools.md)
