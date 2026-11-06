# Warm-pool reconnect references

The pool warms generic containers, not complete notebook sessions. Claiming one
still reserves it through `WarmPoolStore` and runs a command health probe before
handoff. Workspace restoration, credential injection, and kernel launch follow.

## Fast path

`SandboxInstance.reconnectReference` is an optional, credential-free provider
locator obtained after readiness. `WarmPoolService` validates and publishes it
with the member's `ready` state in the existing CAS-owned pool record. It is
passed back only through `SandboxProvider.connectExisting` and is never taken
from the session request. Core treats it as an opaque string (at most 4 KiB), not
an SDK handle or an authentication token.

CoreWeave encodes a versioned kind, the Hub sandbox ID, and its assigned provider
container ID. The adapter rejects malformed references or a different Hub ID
before making requests. A valid reference selects the exact container with one
Get, then checks the returned ID and `running` status. The existing command probe
still runs. A missing/stopped container fails the claim; a reference never falls
back to tag discovery or creates a replacement under the same logical ID.

Thus a referenced warm claim makes **Get + command probe**, rather than
**List-by-tag + Get + command probe**. This removes discovery from the critical
path; it does not eliminate the shared-record reservation or all network time.
The SDK client and transport channels remain reused by the provider.

`coreweave_ensure` reports `reconnect_by_reference=true`, `get_ms`, and zero
`find_ms`, `create_ms`, and `boot_ms` on this path. Get time is not reported as
container creation. Direct runner access can reduce command transport overhead;
this change neither provisions that endpoint nor increases probe deadlines.

## Compatibility and lifecycle

- Providers without reconnect references retain their existing behavior.
- Existing pool members without a reference use tag discovery. A successful
  maintenance health check backfills their reference through a fenced update,
  without replacing their container or changing pool configuration fingerprints.
- References are published only after successful readiness/probing. Publication,
  health updates, claims, assignment, and reclamation keep their existing token
  and state checks. A stale health check cannot overwrite a concurrently claimed
  member.
- The locator is a server-owned mapping, not a signed authorization capability.
  Its integrity relies on the same private bucket/CAS ownership as the pool
  record. Do not accept reconnect references from clients.
- Explicit reference-backed handle destruction deletes only the recorded
  provider ID, with idempotent not-found handling. Pool reclamation retains its
  existing ownership re-read and tag-based orphan cleanup behavior.
- New releases read legacy records without this optional field. Older writers may
  strip it during a rolling deployment; the legacy path and later health-check
  backfill allow operation to continue safely until both tiers are upgraded.

This is a discovery-latency improvement. Separating reconnect/probe deadlines is
a complementary reliability change; skipping health checks or caching stale
readiness is not part of this change.
