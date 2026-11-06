# Warm-pool reconnect references

Warm pools prepare generic containers. A claim reserves a container through
`WarmPoolStore` and runs a command probe before handoff. Workspace restoration,
credential injection, and kernel launch follow.

## Reconnect path

| Pool member     | CoreWeave claim path                            |
| --------------- | ----------------------------------------------- |
| No reference    | Reserve → List by Hub tag → Get → command probe |
| Saved reference | Reserve → Get by provider ID → command probe    |

`SandboxInstance.reconnectReference` is an optional provider locator without
credentials. After readiness and a successful probe, `WarmPoolService` stores
it with the member's `ready` state through CAS. Core treats the reference as an
opaque string of 1–4096 UTF-16 code units (`string.length`).

CoreWeave references contain `kind: 'coreweave-v1'`, the Hub sandbox ID, and a
provider container ID of 1–256 UTF-16 code units. The adapter rejects malformed
references, extra fields, and mismatched Hub IDs before network requests.
The Get result must have the expected container ID and `running` status.
A handle without status metadata cannot satisfy a saved reference.

A failed lookup or probe retires the member and returns a warm-pool miss.
The reference path never discovers another container or creates a replacement
under the same Hub ID. The caller can use the normal cold-start path.

`coreweave_ensure` reports `reconnect_by_reference=true` and `get_ms` for this path.
It reports zero for `find_ms`, `create_ms`, and `boot_ms`. Probe deadlines stay unchanged.

After a successful claim, the service drains optional adapter timings and counters
so provisioning does not count the lookup and probe again. Claim cost remains in
`warm_pool.claim_ms`, with lookup details in `coreweave_ensure`. Diagnostic drain
failures produce safe logs and do not reject a healthy claim.

## Ownership and cleanup

References come from the stored pool member, never from a session request.
They are server-owned mappings, not authorization tokens. Their integrity depends
on the private bucket and the existing CAS ownership rules.

State and token checks prevent stale health checks from changing a concurrently
claimed member. An invalid reference from a provider fails publication or retires
the member during a health check.

Explicit destruction of a handle with a reference targets only its provider ID.
A not-found response counts as successful deletion. Other deletion errors propagate
so callers can retry. Pool reclamation still re-reads ownership and uses the
existing tag-based cleanup path.

## Compatibility

Members and providers without references retain the legacy path, including
injected clients without status metadata. A successful maintenance health check
adds a reference without replacing the container or changing the pool configuration
fingerprint.

Older writers can strip the optional field during a rolling upgrade. Claims
then use the legacy path until a health check restores the reference.
Both the API and maintenance tiers need the new version. No pool reset is necessary.
