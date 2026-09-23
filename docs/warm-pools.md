# Warm sandbox pools

Warm pools reduce provider startup time for CoreWeave and Kubernetes editor and app sessions. They are disabled by default.

These are the initial built-in backends. External compute adapters can opt into the same provider contract.

A warm sandbox runs the default image and passes a command check. Notebook files, credentials, dependencies, and kernels load after assignment. Warm pools do not eliminate notebook setup time.

## Configuration

Set these variables on both the API and maintenance replicas:

```sh
MARIMOHUB_COMPUTE_WARM_POOL_ENABLED=true
MARIMOHUB_COMPUTE_WARM_POOL_SIZE=2
MARIMOHUB_COMPUTE_WARM_POOL_PROFILES=default
```

| Variable                               | Default   | Meaning                                                                              |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| `MARIMOHUB_COMPUTE_WARM_POOL_ENABLED`  | `false`   | Enable warm pools for `coreweave` or `kubernetes`.                                   |
| `MARIMOHUB_COMPUTE_WARM_POOL_SIZE`     | `1`       | Positive integer target of idle sandboxes per selected profile.                      |
| `MARIMOHUB_COMPUTE_WARM_POOL_PROFILES` | `default` | `default` selects the first compute profile; `all` selects every configured profile. |

Without compute profiles, one pool uses adapter defaults. Capacity is shared across server replicas. Three profiles with size two maintain six idle sandboxes.

Idle sandboxes consume compute. Assigned sandboxes stop counting toward the idle target. The maintenance replica creates replacements.

Run one maintenance replica with `MARIMOHUB_RUN_MAINTENANCE=true`. Without it, sessions start cold when the pool is empty.

For Helm deployments, keep `maintenance.enabled: true` and add the variables under `config`:

```yaml
config:
  MARIMOHUB_COMPUTE_WARM_POOL_ENABLED: 'true'
  MARIMOHUB_COMPUTE_WARM_POOL_SIZE: '2'
  MARIMOHUB_COMPUTE_WARM_POOL_PROFILES: default
```

## Assignment and cleanup

Editor and app sessions, including MCP launches, can claim warm sandboxes. Existing session reuse and capacity limits apply first.

Jobs, diagnostics, personal-home mounts, snapshot restores, and non-default images use cold creation. An empty, unhealthy, or unavailable pool also uses cold creation.

Each claim has one owner. A claimed sandbox never returns to the pool, even if session startup fails. Session teardown destroys assigned sandboxes.

Maintenance starts immediately and checks every five seconds. It creates at most two sandboxes concurrently and retries failed creation with increasing delays, capped at five minutes.

Idle sandboxes retire after 30 minutes at most. CoreWeave sandboxes retire earlier if their remaining provider lifetime cannot cover the session and startup allowances.

CoreWeave requires a finite startup timeout. Its provider lifetime must exceed the session lifetime plus startup, ten minutes for teardown, and five minutes for creation.

Changing creation configuration replaces incompatible idle sandboxes. Use immutable image tags or digests; changing an image behind the same tag does not change the configuration fingerprint.

To disable pooling, set `MARIMOHUB_COMPUTE_WARM_POOL_ENABLED=false` on all replicas. Keep maintenance running until it drains unused sandboxes. Assigned sessions continue normally.

Disabled pools check for cleanup every five minutes, including after the pool becomes empty. This catches late creation results from draining replicas.

Before changing compute backends, namespaces, clusters, or provider accounts, disable pooling and drain the old pool. Cleanup needs its original configuration and credentials.

## Operations

Metrics include `warm_pool.ready`, `warm_pool.creating`, `warm_pool.hit`, `warm_pool.miss`, `warm_pool.bypass`, and `warm_pool.claim_ms`.

Creation, health, and cleanup failures produce structured `warm_pool_*` logs. Existing session startup logs include `warm_pool_hit` and phase timings.

The pool stores ownership under `_system/warm-pools/{backend}.json`. Preserve these records during upgrades. Corrupt ownership records block orphan deletion until the records are repaired.

With backend credentials exported, run the opt-in live smoke test separately for each backend:

```sh
MARIMOHUB_WARM_POOL_LIVE_TEST=true pnpm --filter @marimo-hub/config test warmPool.live --run
```

The test creates billable sandboxes, reconnects through another provider instance, checks replenishment, and destroys its sandboxes. It reports cold preparation and warm claim times.
