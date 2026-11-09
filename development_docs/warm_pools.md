# Warm pools

Warm pools keep booted, unassigned sandboxes ready for editor and app sessions. Capacity is deployment-wide, per compute profile, and opt-in.
Notebook files, credentials, and kernels load after assignment.

## Ownership and lifecycle

`WarmPoolStore` alone writes `_system/warm-pools/{backend}.json` through bucket CAS.
`WarmPoolService` manages `creating`, `ready`, `claimed`, and `retiring` members.

1. Maintenance persists creation reservations before provider calls. Creating and ready members count toward the target.
2. A sandbox becomes ready after `ready()` and a bounded command probe succeed.
   Between the probe and readiness, fill pre-installs the notebook bridge with `--install-only`.
   A failed pre-install keeps the member, and the kernel launcher retries installation.
   See [Installation and sandbox images](../packages/notebook-bridge/README.md#installation-and-sandbox-images).
3. Reservation records the destination and changes the operation token. Reconnect and a bounded probe overlap session publication and admission.
4. Handoff checks the current session, claim token, and deadline while URL preparation runs. Workspace writes and credential injection wait for handoff.
5. Session teardown owns assigned sandboxes. Claims never return to the pool. Failed cleanup retains ownership for retry.

If the probe fails or the claim expires, the route replaces the starting session's sandbox ID and repeats URL preparation.
The old member remains owned until cleanup succeeds.

Maintenance runs every five seconds under its own lease. Idle members rotate after at most 30 minutes, sooner for limited provider lifetimes.
Disabling pooling drains unassigned members. Unreadable ownership blocks orphan deletion.

## Provider boundary

`SandboxProvider.warmPool` declares the lifetime limit and additional creation inputs. `connectExisting()` must never create a replacement.
Configuration fingerprints include the image, profile, provider inputs, and deployment configuration.
CoreWeave and Kubernetes are the initial built-ins. Shared lifecycle code has no backend allowlist. See the [provider contract](./ports.md#warm-pool-support).

Jobs, diagnostics, non-default images, home mounts, and snapshot restores bypass pooling. Empty or unhealthy pools fall back to cold creation.
For [app pools](./app_pools.md), `bindWarmSandbox()` changes the unstarted reservation under its existing operation token.

## Reconnect references

`SandboxInstance.reconnectReference` is an optional, credential-free provider locator.
Core treats it as an opaque string of 1–4096 UTF-16 code units.
After readiness and a successful command probe, `WarmPoolService` stores it on the `ready` member through CAS.
Health checks backfill it for members without one.
References come only from the stored member, never from a session request.
They are server-owned mappings, not authorization tokens.

Claims and health checks pass the stored reference to `connectExisting(id, { reconnectReference })`.
That call resolves exactly the referenced sandbox or fails. It never discovers or creates a sandbox.
Failed lookups or probes retire the member. Maintenance replenishes the pool.
Members without a reference use the adapter's discovery path.

Upgrades and rollbacks:

- The reference does not change the configuration fingerprint, so adding it needs no pool reset.
- During a rolling upgrade, older writers can drop the field. Claims then use discovery until a health check restores it.
- If the adapter rejects a reference kind, each member with that kind retires once. The result is one wave of cold starts within a health-check interval, with no leaked sandboxes.
- A new reference kind must keep accepting older kinds, so that upgrades and rollbacks do not churn the pool.

After a successful probe, the service drains adapter diagnostics to exclude them from provisioning telemetry.
`warm_pool.claim_ms` measures reservation time.
The CoreWeave reference format is in its [adapter README](../packages/compute-coreweave/README.md#warm-pool-references).

## Code

- [Store](../packages/core/src/services/runtime/WarmPoolStore.ts) and [service](../packages/core/src/services/runtime/WarmPoolService.ts): durable ownership and lifecycle. Tests are colocated.
- [Configuration](../packages/config/src/warmPool.ts): eligibility, lifetime allowance, and fingerprints.
- [Session routes](../packages/api/src/routes/sessions.ts): allocation and handoff. [Server maintenance](../apps/server/src/cron.ts): replenishment.

[Operator configuration](../docs/warm-pools.md)
