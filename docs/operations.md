---
description: Operate, scale, back up, upgrade, observe, and control the cost of a marimohub deployment.
---

# Operations

Running marimohub day-to-day. The API tier is **stateless** — all state lives in
your object store — so most operations reduce to "back up the bucket" and "roll
the image".

## Health & readiness

- `GET /api/health` → `{ "status": "ok" }` — cheap, unauthenticated, touches no
  downstream deps. Wire this to the API pods' **liveness/readiness** probes.
- `GET /api/health/maintenance` → liveness of the
  [background loops](#background-loops) on the maintenance replica.
  Unauthenticated and process-local: it reads in-memory loop state and calls no
  dependency. Like `/api/health`, it is not in the OpenAPI spec and its body has
  no `{ success, data }` envelope. Wire it to the maintenance pod's
  **liveness** probe only.
- `GET /api/health?deep=true` → runs the **preflight** suite (storage, OIDC,
  compute, WIF) and reports each check. **Authenticated** (it names backends).
  Returns `200` when healthy, `503` when a dependency check fails. Use it for
  on-demand diagnostics after a deploy — don't wire it to a probe, it calls
  downstream deps on every request.
- `GET /api/v1/version` → deploy version, image, backends, and process start time;
  handy for confirming what's running.

`/api/health/maintenance` responds with one of:

| Body                                       | HTTP  | Meaning                                                                                               |
| ------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------- |
| `{ "status": "ok", "loops": {…} }`         | `200` | No loop is `failing` or `stalled`, and no successful retention attempt triggers the duration warning. |
| `{ "status": "degraded", "loops": {…} }`   | `200` | A loop failed, or retention reached 80% of its deadline or stalled.                                   |
| `{ "status": "stalled", "loops": {…} }`    | `503` | A non-retention loop stalled. Restarting the pod can recover.                                         |
| `{ "status": "unavailable", "loops": {} }` | `200` | This process runs no loops (`MARIMOHUB_RUN_MAINTENANCE` is not `true`, e.g. API pods).                |

A dependency outage (storage, compute) makes a loop `failing`, so the pod stays
up and keeps retrying. A successful `retention_*` loop also makes the response
`degraded` when `last_duration_ms >= 0.8 × deadline_ms`: 12 minutes with the
15-minute retention deadline. Its per-loop status remains `ok`. This warning
intentionally returns `200` because a restart cannot fix slow work that still
completes. Before any attempt completes, the response remains `ok` unless a
loop stalls.

Only a stalled non-retention loop returns `503`. Overdue retention returns `degraded` with HTTP 200 so cleanup can finish. The Helm chart and the example Kubernetes
manifests wire the maintenance Deployment's `livenessProbe`
to this endpoint (`initialDelaySeconds: 10`, `periodSeconds: 20`,
`timeoutSeconds: 5`, `failureThreshold: 3`). API pods keep `/api/health`.

### Sandbox startup diagnostic

Super admins can measure sandbox startup from the **Admin → Debug** page. This
session-only page calls `POST /api/v1/admin/debug/sandbox-startup` and rejects
PATs.

Each run creates a temporary sandbox with the selected image and compute
profile. A fixed echo command checks readiness. A second echo measures
steady-state exec latency. The diagnostic always destroys the sandbox. It
reports create, readiness, exec, cleanup, and backend startup timings.

An optional environment-setup benchmark runs a fresh `uv sync` for a pinned
package that is not in the base image. It also measures a runtime and CPU-limit
probe and wheel-download throughput.

A bucket lease limits each admin to one active diagnostic. A concurrent request
returns `429`. Each run emits a `sandbox_startup_diagnostic` wide log event with
the same timings as the report.

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
- **Maintenance**: [background loops](#background-loops) expire old sessions
  and reap sandboxes. Run it on **exactly one** replica via `MARIMOHUB_RUN_MAINTENANCE=true`
  (the chart ships a dedicated single-replica `Recreate` deployment for this).
  Running it on every replica is wasteful but safe — a bucket-CAS lease guards it.
  The same replica also runs the **session lifecycle sweep**: it saves live
  notebooks periodically and attempts safe stops at their lifetime or idle
  deadline. It extends sessions while editors remain connected. Failed captures
  retain the runtime and its last confirmed version; provider kills can lose
  all edits newer than that version. Tune it with the
  `MARIMOHUB_SESSION_*` variables (see [configuration](./configuration.md));
  provider lifetime caps default to 2× the session lifetime as a last-resort
  backstop. With `MARIMOHUB_JOBS=on` it also runs the **job scheduler**: every
  `MARIMOHUB_JOBS_TICK_SECONDS` it fires due [notebook jobs](./jobs.md),
  dispatches queued runs under the concurrency caps, and reclaims runs past
  their deadline. Jobs are accepted but never run without this replica.

## Shutdown budgets

On SIGTERM or SIGINT, the Node server:

1. Stops loop ticks and closes its HTTP listener.
2. Gives requests 10 seconds or half the drain budget, whichever is shorter. It then closes idle connections and WebSockets so open tabs do not hold the drain.
3. Drains background, maintenance, and runtime work, including captures and destroys that outlive their deadlines. Maintenance finishes its current step, skips the rest, and releases its lease.
4. Disposes compute clients and flushes telemetry.

`MARIMOHUB_SHUTDOWN_TIMEOUT_SECONDS` sets the drain budget.
The default is 180 seconds on API replicas and 120 seconds on maintenance.
The API budget allows two waves of 16 session teardowns that each take 60 seconds.
Larger queues or slower providers can still exceed the budget; lifecycle maintenance retries unfinished stops.
On expiry, the server logs `drain_timeout` and allows up to 10 seconds for final cleanup. A forced exit can interrupt unfinished captures.
A second signal during the drain exits immediately, without cleanup.

Set the platform's kill window to the drain budget plus 20 seconds or more.
With the defaults, this is 200 seconds for API replicas and 140 seconds for maintenance.

| Platform          | Setting (default)                                                     | Guidance                                                                                                 |
| ----------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Kubernetes / Helm | `terminationGracePeriodSeconds` (chart: API 200 s, maintenance 140 s) | The chart derives it from the drain budget.                                                              |
| Docker / Compose  | `stop_grace_period`, `docker stop -t` (10 s)                          | Set `200s` on API replicas and `140s` on maintenance. The compose examples set `140s`.                   |
| Cloud Run         | Fixed (10 s)                                                          | Set the budget to 10 or less on every service. Expect a forced drain, or run maintenance on GKE or a VM. |
| Amazon ECS        | `stopTimeout` (30 s, maximum 120 s)                                   | Set `stopTimeout: 120` and a drain budget of 100 or less on both API and maintenance tasks.              |
| systemd           | `TimeoutStopSec` (90 s)                                               | Set `TimeoutStopSec=200` on API units and `140` on maintenance, or lower the budget.                     |

With Helm, set the maintenance budget through `maintenance.shutdownTimeoutSeconds`.
The chart rejects `MARIMOHUB_SHUTDOWN_TIMEOUT_SECONDS` in `extraEnv`, `config`, and `secrets.data`.
Helm cannot read the Secret that `secrets.existingSecret` names, so do not put the variable there.
This keeps each drain budget within its pod termination grace.

## Session stop and recovery

Normal stops save persistent local editors before stopping their writers. If saving
fails, the runtime remains available when resume is confirmed. The editor offers
**Retry save**, **Keep running**, and a separately confirmed **Force stop**.
Force can discard changes since the last confirmed capture. Restart waits for a
successful stop before starting a replacement.

[The API reference](./api.md#endpoints) defines the stop status codes and retry keys.
A pending attempt retains its editor claim and capacity slot. Maintenance reconciles
unfinished attempts; it does not replay an abandoned interactive failure.
Automatic idle and lifetime attempts recheck eligibility and back off after failure.
Authorization expiry still enforces security teardown independently of saving.

Safe capture requires the Linux lifecycle supervisor and the supported marimo 0.24.x
adapter. Native macOS runtimes and unsupported launch strategies retain the editor
when safe capture is unavailable. Users can explicitly force stop them.
Direct runtime exposure has no proxy save observation and relies on periodic capture.
Neither mode protects unsaved browser buffers or prevents an external provider kill.

Deploy the publication readers, writers, and runtime support together. Drain old hub
writers before admitting sessions with this protocol. Mixed workers can bypass the
publication fence or destroy a runtime after a failed save. Back up each source head
and its referenced immutable payloads together.

## Background loops

The maintenance replica runs these loops. Each loop starts at once, then repeats at its interval.
Each leased loop has its own bucket-CAS lease, so only one replica does the work.
Most loops take the lease for each attempt.
The app-pool, warm-pool, search, and job scheduler loops keep their lease between attempts.

| Loop                        | Interval                                                                 | Lease                                         | Runs when                     |
| --------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------- |
| `maintenance`               | 5 min                                                                    | `_system/_maintenance.lock`                   | Always                        |
| `app_pools`                 | Session sweep interval (default 60 s), or 60 s without session lifetimes | `_system/app-pool-maintenance-lock.json`      | Always                        |
| `retention_notebook_gc`     | 1 hour                                                                   | `_system/retention-notebook_gc-lock.json`     | Always                        |
| `retention_snapshot_expiry` | 1 hour                                                                   | `_system/retention-snapshot_expiry-lock.json` | Always                        |
| `retention_jobs`            | 1 hour                                                                   | `_system/retention-jobs-lock.json`            | `MARIMOHUB_JOBS=on`           |
| `session_lifecycle`         | `MARIMOHUB_SESSION_SWEEP_INTERVAL_SECONDS` (default 60 s)                | `_system/_session_lifecycle.lock`             | Session lifetimes are enabled |
| `warm_pool`                 | 5 s (5 min while warm pools are disabled)                                | `_system/_warm_pool.lock`                     | A warm pool is configured     |
| `job_scheduler`             | `MARIMOHUB_JOBS_TICK_SECONDS` (default 60 s)                             | `_system/_jobs.lock`                          | `MARIMOHUB_JOBS=on`           |
| `search_indexing`           | 5 s                                                                      | `_system/search/lock.json`                    | Search is configured          |
| `preview_preparation`       | 15 s                                                                     | None                                          | Source control is configured  |

Every Node process, including API replicas, also runs two loops without a loop lease.
`migrations` runs every 5 seconds until all [bucket migrations](https://github.com/marimo-team/marimohub/blob/main/development_docs/migrations.md) complete.
`warm_pool_preconnect` runs every 5 seconds while [warm pools](./warm-pools.md) are enabled, `MARIMOHUB_COMPUTE_WARM_POOL_PRECONNECT` is not `false`, and the compute adapter supports preconnection.

The `app_pools` loop uses `MARIMOHUB_SESSION_SWEEP_INTERVAL_SECONDS` when session
lifetimes are enabled. App-pool sweeps run only in this loop. The hourly retention
loops run independently of maintenance and each other. `retention_notebook_gc`
cleans deleted projects, then deleted notebooks and their orphaned filesystem snapshots.
Each non-empty retention attempt emits `retention_cycle` with its step and counts.

Each retention attempt has a 15-minute deadline. Search indexing has a 30-second
deadline. [Search](./search.md) covers its configuration and index freshness.
Other attempts have a deadline of `max(3 × interval, 10 min)`.
The deadline covers lease acquisition, the work, and lease release.
When an attempt passes its deadline, the runner aborts it and logs `<loop>_stalled` at `level: error`.
The event carries `holder`, `deadline_ms`, and `duration_ms`.
This process starts no new attempt for that loop until the abandoned work settles.
The lease still expires, so another replica can take it while the abandoned work runs.
When the work settles, the runner logs `<loop>_recovered` at `level: debug` and discards the late result.
The next tick retries.
A skipped attempt counts as a success. An attempt skips when another replica holds the lease or when there is no work.

Other loop events: `<loop>_failed` (`warm_pool_sweep_failed` for the warm pool)
when an attempt fails, `<loop>_release_failed` when releasing the lease fails
(the attempt's outcome stands), and `<loop>_report_failed` when recording the
outcome fails.

`/api/health/maintenance` reports each loop with these fields:

| Field                                                     | Meaning                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `status`                                                  | `ok`, `failing` (last attempt failed), `stalled`, or `stopping` (shutdown began). |
| `last_started_at`, `last_completed_at`, `last_success_at` | Unix milliseconds; `null` until the first one happens.                            |
| `last_duration_ms`, `seconds_since_success`               | Duration of the last attempt; time since the last success.                        |
| `consecutive_failures`, `timeouts`                        | Failed attempts since the last success; deadline hits since boot.                 |
| `interval_ms`, `deadline_ms`                              | The loop's configuration.                                                         |

A loop is `stalled` when an attempt is past its deadline and has not settled, or
when no attempt has completed within one deadline plus one interval.

Every `maintenance_cycle` event carries, per loop, `gauge.loop.<loop>.seconds_since_success`,
`gauge.loop.<loop>.last_duration_ms`, `gauge.loop.<loop>.consecutive_failures`,
`gauge.loop.<loop>.stalled` (`0` or `1`), and `counter.loop.<loop>.timeouts`.
With [OTEL metrics](#metrics-opentelemetry) on, the same signals export as the
gauges `loop.seconds_since_success`, `loop.consecutive_failures`,
`loop.last_duration_ms`, and `loop.stalled`, and the counter `loop.timeouts`,
each tagged `loop=<loop>`.

The single-writer design behind these leases is in the
[operations runbook](https://github.com/marimo-team/marimohub/blob/main/development_docs/operations.md#3-the-single-cron-guarantee).

### Deleted project cleanup

Maintenance purges soft-deleted projects after 30 days, using project metadata
even if the catalog still marks them active. Missing metadata triggers cleanup
of the remaining objects. Unreadable or invalid metadata logs
`projects.cleanup_failed` and leaves the project intact.

The catalog entry remains until cleanup succeeds, so later sweeps can retry failures.
Each sweep attempts at most 25 projects with one five-minute budget for the entire purge batch, checked between projects. Metadata discovery and an in-progress deletion can extend the elapsed time.
Each project deletes at most five pages of 200 objects. Remaining objects preserve progress across restarts.
App pool tombstones and preview records follow separate retention rules.

## Reclaim a stuck editor sandbox

Cleanup of a retired editor session normally finishes on its own; see
[Editor sessions](./editor-sessions.md#session-cleanup) for when it waits.

Super admins can force it from **Admin → Runtime → Editors → Reclaim session**
(`POST /api/v1/admin/runtime/projects/{pid}/sessions/{sid}/reclaim`, optional
body `{ "save": false }`; `save` defaults to `true`). A successful reclaim
returns `200` with
`{ "success": true, "data": { "reclaimed": true, "saved": true } }` (`saved` is
`false` when nothing was saved).

A blocked reclaim returns the generic `CONFLICT` (`409`) or
`SERVICE_UNAVAILABLE` (`503`) error code. The error `message` describes the
cause; the response has no machine-readable reason field.

| Response | Cause                                                                  | Action                                               |
| -------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `409`    | `not_terminal`                                                         | Stop the session first.                              |
| `409`    | `provision_grace`, `teardown_grace`, `kernel_active`                   | Wait for the grace period or for editors to leave.   |
| `409`    | `attachment_unsupported`                                               | Reclaim without saving; unsaved edits are discarded. |
| `503`    | `attachment_failed`, `kernel_unreachable`, `destroy_failed`, `timeout` | Transient; retry after `Retry-After`.                |

Runtime inspection shows `reclaimable` and `reclaim_blocked_reason` on each
editor row. It reports the causes that need no sandbox call (`not_terminal`,
the grace periods, and `attachment_unsupported`). Each attempt writes a
`session.reclaim` audit event with the actor, `save_requested`, `reclaimed`, and
`saved` or the blocking reason, so the audit log records every cause.

**Known limitation:** providers that cannot attach to an existing sandbox
(currently Cloudflare) cannot save a retired session. Before the session's
authorization deadline, sessions that may hold unsaved edits stay until a super
admin reclaims them without saving. After it, automatic cleanup destroys the
sandbox without saving.

## Backups & restore

There is no database. The object store is the **single source of truth** —
notebooks, version history, and the catalog all live there.

- **Back up** by backing up the bucket: server-side versioning + lifecycle
  rules, cross-region replication, or scheduled `aws s3 sync` / `gsutil rsync` /
  `azcopy sync` to a second bucket. Everything except the in-flight kernel
  filesystem is durable and restorable.
- **Restore** by pointing a fresh marimohub at a bucket with your objects — no
  migration step. Immutable snapshots and versions hold content history. The
  catalog pointer, sessions, identities, tokens, and editor/app claims are
  mutable records. Restore all of them from the same point-in-time bucket
  snapshot. Their write rules are described in
  [How it works](./architecture.md).
- **Recover the catalog** with [catalog recovery](#catalog-recovery) when a
  restore or an outage leaves `_system/catalog.json` or its current snapshot
  missing.

::: tip Notebook history is already in the store
Per-notebook version history is kept in object storage, so bucket backups
capture it automatically — no separate export.
:::

## Catalog recovery

The hub blocks, with `NOT_INITIALIZED` and `Catalog recovery required`, when the current snapshot is missing or `_system/catalog.json` is missing while data exists.
Empty `system.initialize` snapshots from a crashed or concurrent first boot do not count as data.
The hub never recovers automatically; only fresh storage initializes on boot.

The offline `catalog-recovery` command in the container image writes a new catalog snapshot.
`--rebuild` discovers projects, notebooks, and jobs from records. `--snapshot SNAPSHOT_ID` restores a surviving snapshot's membership with current metadata.
It supports the `s3`, `gcs`, `azure`, and `fs` backends. Run it with `--help` for the flags.

Recovery refuses to run while any [notebook move](./organizing-projects.md#move-a-notebook-to-another-project) is not `complete`.
Before you stop the writers, finish each pending move: repeat it, or cancel it if it has not published.

1. [Back up](#backups-restore) the bucket.
2. Stop all writers until step 6: API replicas, maintenance processes, scheduled triggers, and notebook sandboxes.
3. Run a dry-run (the default) with the deployment's `MARIMOHUB_STORAGE_*` variables and `--rebuild` or `--snapshot SNAPSHOT_ID`. Prefer a `current` or `previous` snapshot candidate; an `unverified` snapshot can be an uncommitted write.
4. Review the JSON report. Errors block apply. Warnings require `--accept-warnings`; rebuild always warns, because discovery cannot prove that a record was published. `excluded` issues list records left out of the catalog: preview runtime notebooks, import attempts not confirmed complete, jobs with a deletion fence, and, in `--snapshot` mode, projects, notebooks, and jobs absent from the selected snapshot.
5. Run the same command with `--apply REPORT_TOKEN --writers-stopped --actor USER_ID`. `USER_ID` is the operator's marimohub user ID, recorded in the snapshot and a `system.recover` audit event.
6. Check the recovered projects and notebooks, then restart the writers.

The token covers the report and everything under `projects/`, `_system/snapshots/`, `_system/job-deletions/`, and `_system/catalog.json`, so any change after the dry-run makes it stale.
If another writer moves the catalog pointer during apply, the command deletes its snapshot and exits with a conflict; run the dry-run again.

| Exit code | Meaning                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| 0         | Dry-run report has no blocking errors (warnings and exclusions are allowed), or apply succeeded.                           |
| 1         | Invalid arguments, unsupported storage, stale token, unaccepted warnings, blocked apply, write conflict, or storage error. |
| 2         | Dry-run report has blocking errors. The report is on stdout; the reasons are on stderr.                                    |

Limits:

- Snapshot mode keeps current metadata, including deletion status, permissions, security labels, and job schedules. Deleted projects and notebooks keep their status.
- Rebuild mode can include ambiguous records left by failed creates or expired import receipts. Review every entry.
- Missing or invalid metadata, referenced notebook content, or job history indexes block apply. Recovery does not repair these objects or restore history.

Docker (with `fs` storage, also mount the storage directory at the hub's path, for example `-v /var/lib/marimohub:/var/lib/marimohub`):

```bash
docker compose stop hub   # stop every writer first
docker run --rm --env-file marimohub.env ghcr.io/marimo-team/marimohub:X.Y.Z \
  node dist/catalog-recovery.mjs --rebuild
docker run --rm --env-file marimohub.env ghcr.io/marimo-team/marimohub:X.Y.Z \
  node dist/catalog-recovery.mjs --rebuild --accept-warnings \
  --apply REPORT_TOKEN --writers-stopped --actor USER_ID
```

Kubernetes, for a Helm release named `marimohub` (add any `extraEnv` values the Deployments set; for apply, append the apply flags to `command`):

```bash
kubectl scale deployment marimohub marimohub-maintenance --replicas=0
kubectl run marimohub-catalog-recovery --rm -i --restart=Never \
  --image=ghcr.io/marimo-team/marimohub:X.Y.Z \
  --overrides='{"spec":{"serviceAccountName":"marimohub","containers":[{
    "name":"marimohub-catalog-recovery","image":"ghcr.io/marimo-team/marimohub:X.Y.Z",
    "command":["node","dist/catalog-recovery.mjs","--rebuild"],
    "envFrom":[{"configMapRef":{"name":"marimohub-config"}},{"secretRef":{"name":"marimohub-secrets"}}]}]}}'
```

The `marimohub-linux-*` binaries do not include the command. From a repository checkout, `pnpm --filter @marimo-hub/server catalog:recover` takes the same arguments.

## Upgrades

The image and Helm chart are released together on every `v*` tag (chart version,
`appVersion`, and image tag all match), so pinning a chart version pins
everything.

```bash
helm upgrade marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version <VERSION> -n marimohub -f values.yaml
helm history marimohub -n marimohub      # what's running
```

Replace `<VERSION>` with a tag from
[GitHub Releases](https://github.com/marimo-team/marimohub/releases), without
the leading `v`. See [Deploying with Helm](/deploying/helm).

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
activity, snapshot timing. When a sandbox environment setup takes longer than
2 s, a `sandbox_setup_slow` warning records per-step timings and up to 4 KiB of
trailing stderr. Ship stdout to your log pipeline and alert on
`level: error` events (e.g. `boot_failed`, `unhandled_rejection`). Set an OTLP
endpoint (see [Logs](#logs-opentelemetry) below) to also ship these lines over
OpenTelemetry, so they outlive the pod after a redeploy.

### Session provision events

The server emits `session_provision` when a provisioning attempt finishes, including failed attempts.
Retiring-editor conflicts also emit it, including any wait and retry.
Other requests that reuse a session or fail before provisioning do not emit this event.
The `client` field groups requests by route and authentication:

| `client` | Meaning                                                                                 |
| -------- | --------------------------------------------------------------------------------------- |
| `mcp`    | Requests through `/mcp`, regardless of credential type.                                 |
| `web`    | REST requests with SSO or development authentication.                                   |
| `cli`    | REST requests with token authentication, including API scripts and other token callers. |

When present, `session_id` identifies the session record and `provision_error_code` identifies a provisioning failure.

Phase timings such as `provision_files_ms` overlap. When the workspace is copied
into the sandbox, bounded workspace reads start while the sandbox boots, so
`provision_files_ms` includes the readiness wait as well as the copy. Mounted
workspaces, and reads over the prefetch budget, wait for readiness first. Do not
sum phase timings; use `total_ms` for the full start request.

| Field                | Measures                                                               |
| -------------------- | ---------------------------------------------------------------------- |
| `total_ms`           | Full session start, including a stop wait and retry.                   |
| `auth_reuse_ms`      | Pre-saga admission, authorization, and reuse work across all attempts. |
| `stop_wait_ms`       | Wait for the same user’s retiring editor; zero when no wait occurs.    |
| `warm_probe_ms`      | Warm sandbox probe, when attempted.                                    |
| `ingress_publish_ms` | CoreWeave ingress publication, which overlaps sandbox setup.           |
| `provision_total_ms` | Sandbox provisioning only.                                             |

When CoreWeave uses `kernelIngress` without `resolveExposedUrl`, it starts ingress publication during URL preparation and waits for it before returning the live URL.
That publisher allows 100 service-discovery retries, with a 100 ms delay between attempts.

On every compute backend, these fields split the file and injection phases:

| Field                            | Measures                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `provision_files_waitready_ms`   | The one readiness wait that workspace and Git restores share.                        |
| `provision_files_non_waiting_ms` | Workspace time without that wait: storage reads, queueing, uploads, and preparation. |
| `provision_inject_files_ms`      | Session file preparation, upload, and installation.                                  |
| `provision_inject_env_ms`        | Environment configuration calls. They run at the same time as session file uploads.  |

### Tracing (OpenTelemetry)

Set the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP over HTTP) to enable
tracing: one SERVER span per request through the Hono server, honoring inbound
W3C `traceparent` headers, with nested spans for every domain-service and
storage call (`NotebookService.getNotebook`, `Bucket.get`, …). Span attributes
are limited to resource identifiers and bucket keys — request payloads,
tokens, and emails are never recorded. Sandbox provisioning emits phase spans
such as `sandbox.reachable`, `sandbox.files`, `sandbox.setup`, and
`sandbox.waitport`. The CoreWeave compute adapter emits a CLIENT span for each
gateway request. These spans contain only endpoint, method, timing, and sandbox
ID attributes. They never contain request payloads or credentials.

Each background-loop attempt is a `loop.<loop>` span with
`marimohub.loop.name` and `marimohub.loop.outcome` (`success`, `failed`,
`stalled`, or `skipped`); `failed` and `stalled` set ERROR status. Its children
include `MaintenanceLock.acquire`, `MaintenanceLock.release`, and
`Maintenance.sweepAppPools`. Lock spans carry the lease key as `bucket.key`, and
the acquire span adds `marimohub.lock.acquired` (boolean). Lock contention does
not mark the acquisition span as an error.

The Node server samples 1% of background loop traces before it creates their child spans.
`OTEL_TRACES_LOOP_SAMPLE_RATIO` controls this additional limit, from `0` to `1`.
The global sampler still applies. Set the loop ratio to `1` for diagnostic captures.
Within sampled traces, routine storage and session-read spans are omitted unless they record an error.
Unsampled failures remain visible through operational logs and loop health metrics.

`OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER` /
`OTEL_TRACES_SAMPLER_ARG`, `OTEL_EXPORTER_OTLP_HEADERS`, and
`OTEL_SDK_DISABLED` behave per the [OTEL spec](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/).
Only the OTLP exporter (the spec default) is implemented; any other
`OTEL_TRACES_EXPORTER` value disables tracing. Without an OTLP endpoint, the
server does not export traces. These are standard `OTEL_*`
variables, so they are intentionally absent from the
[Configuration reference](/configuration).

The middleware traces every request, including static assets; use
`OTEL_TRACES_SAMPLER=parentbased_traceidratio` with a ratio in
`OTEL_TRACES_SAMPLER_ARG` to reduce span volume.

Spans, metrics, and logs share one resource. It includes host and process
attributes, a generated `service.instance.id`, and these resource defaults:

| Attribute         | Source              | Default     |
| ----------------- | ------------------- | ----------- |
| `service.name`    | `OTEL_SERVICE_NAME` | `marimohub` |
| `service.version` | `MARIMOHUB_VERSION` | `dev`       |

`OTEL_RESOURCE_ATTRIBUTES` can override resource defaults, including the instance ID.
Release images and standalone executables include the build version.
The `server_started` event records the build version even when telemetry export is disabled.

While tracing is enabled, every log line emitted inside a traced request also
carries `trace_id` / `span_id`, so your log pipeline can pivot from a line
straight to its trace.

### Metrics (OpenTelemetry)

The Node server writes one `request` log line per HTTP request.
Requests to `/api/*` and requests that call the bucket log at `info`.
Other requests log at `debug`. These include static files, `/_marimo` assets, and kernel proxy traffic.
[`LOG_LEVEL`](/configuration) sets the minimum level.

Node request logs include `storage_ops` counts for `get`, `head`, `list`, `put`, `delete`, `putStream`, and the multipart calls `multipart_create`, `multipart_putPart`, `multipart_complete`, and `multipart_abort`. Counts include failed calls and describe bucket-port calls, not provider RPCs.
Counting ends with the response. Deferred work is excluded after that point.
Storage keys and credentials are never included in these counts.

`cache.metadata.reads` includes `cache` and `service` labels, plus the existing result and consistency labels.
`sandbox.reconnect` counts attachment attempts by `path` and `method` (`reference` or `lookup`).
It measures attempts, not successful provider connections.
`session_provision.cap_source` identifies the admission read path: `index` or `scan`.
`notebook.artifact_uploads_skipped` counts unchanged HTML and session snapshots omitted from storage writes.

The Node deferred-work queue reserves 16 execution slots for session teardown.
Long-lived conversations and surface startup promises remain tracked without occupying ordinary queue slots.
Teardown overflow remains tracked without blocking the response. Other queue overflow retains inline fallback.
Queue gauges with `lane=teardown` report the reserved lane; per-label gauges identify individual task types.
Shutdown still uses its configured deadline. It cannot guarantee completion during a prolonged provider outage.

The server records RED metrics per request — the `http.server.request.duration`
histogram (labelled by route, method, and status code) and the
`http.server.active_requests` gauge — plus domain signals: catalog CAS
contention (`catalog.cas.*`), session and reaper activity (`sessions.*`),
snapshot growth (`snapshots.*`, `maintenance.*`), and notebook job activity
(`jobs.*`: fires, dispatches, transitions, CAS conflicts, watchdog timeouts,
retries, and the active-run gauge). Work that runs after the response records
three metrics, each tagged by `label`. They are the `background.in_flight` gauge,
the `background.failed` counter, and the `background.duration_ms` histogram.
Object browsing adds operation
counts and latency (`object_browser.s3.*`), bytes read, keys scanned, metadata
cache outcomes, and active/rejected download signals (`object_browser.download.*`).
Runtime-backed data previews emit
executor selection (`data_preview.selected`) and DuckDB pool, initialization,
execution, timing, row-count, and recycle signals (`data_preview.duckdb.*`).
Attributes are limited to fixed operation, mode, outcome, error-code, executor,
runtime, and recycle-reason values; bucket names, object keys, queries,
integration IDs, and user IDs are never metric attributes. Maintenance signals
also flush as one wide-event log line per cycle. `OTEL_METRICS_EXPORTER` selects
the mode:

- **`otlp`** (default): push over OTLP/HTTP whenever
  `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) is
  set, so pointing the server at a collector exports traces _and_ metrics.
  `OTEL_METRIC_EXPORT_INTERVAL` / `OTEL_METRIC_EXPORT_TIMEOUT` (milliseconds,
  default 60000/30000) set the cadence; `OTEL_METRICS_EXPORTER=none` keeps
  traces without metrics.
- **`prometheus`**: serve a scrape endpoint on `:9464/metrics`
  (`OTEL_EXPORTER_PROMETHEUS_HOST` / `OTEL_EXPORTER_PROMETHEUS_PORT`), no OTLP
  endpoint needed. Keep the port off the public ingress. The Helm chart wires
  this up: `metrics.enabled=true` exposes it on the Service,
  `metrics.serviceMonitor.enabled=true` adds a Prometheus Operator
  ServiceMonitor.

Any other `OTEL_METRICS_EXPORTER` value disables metrics;
`OTEL_SDK_DISABLED=true` turns everything off.

### Session cleanup signals

| Metric                                        | Type    | Meaning                                                                                   |
| --------------------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `sessions.unreclaimed_terminal.count`         | Gauge   | Terminal or terminating sessions whose sandboxes remain unreclaimed after reconciliation. |
| `sessions.unreclaimed_terminal.oldest_age_ms` | Gauge   | Time since the oldest unreclaimed session heartbeat, in milliseconds.                     |
| `sessions.editor_claim.lost`                  | Counter | Editor starts blocked by a retiring claim or a lost claim race.                           |

The maintenance leader records both gauges after each completed reconciliation,
even when provider enumeration is unavailable. An empty result sets both to
zero. Failed or timed-out reconciliation leaves the previous values unchanged,
and late results cannot replace newer ones. A replica that loses leadership
keeps exporting its last values under cumulative temporality, so aggregate these
gauges with `max` across instances, not `sum`.

The editor claim counter's only attribute is `phase`: `preflight` for a retiring
claim (`409 EDIT_SESSION_RETIRING`) and `claim` for a lost race. The affected
session is on the [`session_provision`](#session-provision-events) event as
`editor_claim_lost` and `editor_claim_lost_phase`. Each process counts claim
losses separately; with OTEL metrics off, API-replica counters stay local and
do not appear in the maintenance replica's logs.

The `maintenance_cycle` event includes `sessions_reclaimed` and these signals
with `gauge.` and `counter.` prefixes. Each maintenance reclaim is bounded to
60 s; a timeout logs `session_reclaim_timeout` and the next cycle retries.

### Logs (OpenTelemetry)

The same structured wide-event lines that go to stdout are also exported over
OTLP/HTTP whenever an OTLP endpoint is set, so log history survives a pod
restart or redeploy instead of living only in `kubectl logs`. This covers both
the server's own events (`boot_failed`, `otel_started`, maintenance cycles) and
the request-path events from the API layer (rejections, best-effort failures).
Work that fails after the response logs `background_work_failed`.
Core operational errors also export the sanitized payload written to stderr,
including a fallback event if serialization fails.
Each record carries the wide event's `level` as its severity, its `event` (or
`message`) as the body, and every field as an attribute; while tracing is on it
also joins its trace via `trace_id` / `span_id`.

`OTEL_LOGS_EXPORTER` selects the mode: `otlp` (the spec default) pushes over
OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` (or
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`) is set — so pointing the server at a
collector exports traces, metrics, _and_ logs. `OTEL_LOGS_EXPORTER=none` keeps
traces/metrics without shipping logs (stdout still gets every line); any other
value disables log export, and `OTEL_SDK_DISABLED=true` turns everything off.
stdout is always written regardless, so it stays the source of truth even when
export is off or the collector is unreachable.

## Cost control

Compute backends differ in cost model — pick per [Compute](/compute):

- `modal` / `e2b` / `coreweave`: pay per running kernel. The hub uses
  `MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS` to stop idle sessions. Apps can use
  `MARIMOHUB_SESSION_APP_IDLE_TIMEOUT_SECONDS` instead. Modal uses 1.5 times the
  effective value as its provider fallback. Provider maximum lifetimes remain
  orphan backstops.
- `kubernetes` / `docker`: you own the nodes; cap per-kernel CPU/memory/GPU.
- `MARIMOHUB_MAX_SESSIONS_PER_USER` bounds concurrent kernels per user.

### Background performance metrics

Search exports `search.documents.reused` and `search.documents.read`, tagged by source.
`search.round.duration_ms` measures crawl rounds. `search.snapshot.parse_ms` measures snapshot parsing and posting-list construction.
Notebook cleanup exports `notebook_gc.visited`, `notebook_gc.rotation.position`, and `notebook_gc.rotation.total`.
The rotation gauges show progress through the current notebook catalog.

## Personal GitHub credentials

Personal access and refresh tokens use `MARIMOHUB_SECRETS_KEK`, separately from the App private key and OAuth client secret.
Restrict access to the bucket, backups, KEK, and logs. The installation credentials and OAuth client must belong to the same GitHub App.

Refresh replaces both tokens under a storage claim. An uncertain refresh requires reconnection because the hub cannot safely replay it.
A new connection cannot take over pending publications. Those retain their original connection ID.

Before a mode, App, client-secret, origin, or KEK change:

1. Stop new publication requests.
2. Let dispatched requests finish or reconcile their stored receipts.
3. Keep old decryption keys until users disconnect or you revoke their GitHub grants.
4. Apply the configuration on all instances.
5. Restart instances and verify account status before new publications.

In App mode, retain OAuth configuration and the KEK until existing users disconnect.
The account page still permits disconnect, but disables new connections.
If the App or KEK changes first, local disconnect still clears credentials. Remote revocation can remain uncertain.
In that case, revoke the old App authorization through GitHub.

**After a backup restore, revoke affected GitHub grants and require reconnection before personal writes resume.**
Local records cannot detect restored generations or refresh claims. Restoring the KEK does not make stale tokens safe.
Notebook deletion neither revokes account connections nor erases remote commits.

### Temporary branches and cleanup

Preparation uses random `marimohub/preparation/` branches and durable receipts.
Cleanup deletes a ref only at its recorded SHA. A moved ref remains untouched.
Maintenance can use App credentials for this cleanup, never to publish on a user's behalf.

Retries repeat failed cleanup. Maintenance also cleans terminal or expired preparations and orphan account credentials.
An uncertain dispatch without a recorded result can leave a ref whose ownership the hub cannot establish.

Before manual deletion:

1. Retain the operation receipt and stop the affected operation.
2. Verify the repository, ref, expected parent, and resulting commit against the receipt.
3. Delete only that verified ref. Do not bulk-delete the `marimohub/` prefix.

### Optional live signing test

The live probe requires a disposable repository and GitHub App user credentials.
It creates and deletes a temporary branch without updating the base branch or opening a PR.
Normal tests use deterministic HTTP responses. Production verifies each commit before publication.

1. Set the opt-in variables documented in `packages/source-control-github/src/githubSignedCommit.live.test.ts`.
2. Run `pnpm --filter @marimo-hub/source-control-github exec vp test src/githubSignedCommit.live.test.ts` to bypass the task cache.
