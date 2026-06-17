# Operations

Running marimohub day-to-day. The API tier is **stateless** — all state lives in
your object store — so most operations reduce to "back up the bucket" and "roll
the image".

## Health & readiness

- `GET /api/health` → `{ "status": "ok" }` — cheap, unauthenticated, touches no
  downstream deps. Wire this to your k8s **liveness/readiness** probe.
- `GET /api/health?deep=true` → runs the **preflight** suite (storage, OIDC,
  compute, WIF) and reports each check. **Authenticated** (it names backends).
  Returns `200` when healthy, `503` when a dependency check fails. Use it for
  on-demand diagnostics after a deploy — don't wire it to a probe, it calls
  downstream deps on every request.
- `GET /api/v1/version` → deploy version, image, backends, and process start time;
  handy for confirming what's running.

At boot the server runs the same preflight and logs each check. The two failure
classes behave differently on purpose:

- A **fatal** result — a deterministic, unsafe-to-run misconfiguration (e.g. a
  store that ignores conditional writes, or a malformed WIF signing key) — exits
  non-zero, so the deploy fails instead of corrupting data later.
- A **connectivity** failure (storage/OIDC/compute briefly unreachable) is logged
  as `level: error` but does **not** stop boot, so a transient backend blip can't
  crashloop a replica. Inspect it with `?deep=true` once the pod is up.

## Scaling

- **API**: stateless — run as many replicas as you like behind a load balancer.
  The Helm chart's `replicaCount` controls this.
- **Maintenance**: a single background loop expires old sessions and reaps
  sandboxes. Run it on **exactly one** replica via `MARIMOHUB_RUN_MAINTENANCE=true`
  (the chart ships a dedicated single-replica `Recreate` deployment for this).
  Running it on every replica is wasteful but safe — a bucket-CAS lease guards it.
  The same replica also runs the **session lifecycle sweep**: it saves live
  notebooks every couple of minutes (so a crash or hard kill loses at most one
  interval of edits), gracefully saves + stops sessions at their lifetime or
  idle deadline — extending instead while editors are still connected — and
  destroys sandboxes left behind by expired sessions. Tune it with the
  `MARIMOHUB_SESSION_*` variables (see [configuration](./configuration.md));
  provider lifetime caps default to 2× the session lifetime as a last-resort
  backstop.

## Backups & restore

There is no database. The object store is the **single source of truth** —
notebooks, version history, and the catalog all live there.

- **Back up** by backing up the bucket: server-side versioning + lifecycle
  rules, cross-region replication, or scheduled `aws s3 sync` / `gsutil rsync`
  to a second bucket. Everything except the in-flight kernel filesystem is
  durable and restorable.
- **Restore** by pointing a fresh marimohub at a bucket with your objects — no
  migration step. The catalog pointer (`_system/catalog.json`) is the only
  mutated-in-place object; everything else is immutable/append-only, so a
  point-in-time bucket snapshot is internally consistent.

::: tip Notebook history is already in the store
Per-notebook version history is kept in object storage, so bucket backups
capture it automatically — no separate export.
:::

## Upgrades

The image and Helm chart are released together on every `v*` tag (chart version,
`appVersion`, and image tag all match), so pinning a chart version pins
everything.

```bash
helm upgrade marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version 1.5.0 -n marimohub -f values.yaml
helm rollback marimohub -n marimohub     # revert
helm history marimohub -n marimohub      # what's running
```

See [Deploying with Helm](/deploying/helm). The API tier is stateless, so
rolling upgrades need no draining beyond your normal readiness gating.

## Configuration changes

`MARIMOHUB_*` values are read at startup. To change one, update the
ConfigMap/Secret (or your secrets manager) and restart the pods. Non-secret
values live in `config:`; secrets in a Secret consumed via `envFrom` — see
[Configuration](/configuration) for the full surface.

## Secrets

Keep secret values (`🔒` in the [Configuration reference](/configuration)) out
of your values file. Prefer `secrets.existingSecret` (a Secret you manage)
over inline literals so they stay out of `helm get values`. A secrets manager
(Doppler, External Secrets, …) can sync into that Secret. See
[Security → Secrets](/security#secrets-handling).

## Observability

The server emits **structured wide-event logs** (one JSON line per request /
maintenance cycle) carrying backend signals — catalog CAS contention, reaper
activity, snapshot timing. Ship stdout to your log pipeline and alert on
`level: error` events (e.g. `boot_failed`, `unhandled_rejection`).

## Cost control

Compute backends differ in cost model — pick per [Compute](/compute):

- `modal` / `e2b` / `coreweave`: pay per running kernel. Set
  `MARIMOHUB_COMPUTE_IDLE_TIMEOUT` and per-backend max-lifetime caps so idle or
  orphaned sandboxes stop.
- `kubernetes` / `docker`: you own the nodes; cap per-kernel CPU/memory/GPU.
- `MARIMOHUB_MAX_SESSIONS_PER_USER` bounds concurrent kernels per user.
