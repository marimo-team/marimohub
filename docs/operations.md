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

| Body                                       | HTTP  | Meaning                                                                                |
| ------------------------------------------ | ----- | -------------------------------------------------------------------------------------- |
| `{ "status": "ok", "loops": {…} }`         | `200` | No loop is currently `failing` or `stalled`, including before a first attempt ends.    |
| `{ "status": "degraded", "loops": {…} }`   | `200` | At least one loop is `failing`. A restart would not fix this.                          |
| `{ "status": "stalled", "loops": {…} }`    | `503` | At least one loop is `stalled`. Restarting the pod can recover.                        |
| `{ "status": "unavailable", "loops": {} }` | `200` | This process runs no loops (`MARIMOHUB_RUN_MAINTENANCE` is not `true`, e.g. API pods). |

A dependency outage (storage, compute) makes a loop `failing`, so the pod stays
up and keeps retrying. Only a wedged loop returns `503`. The Helm chart and the
example Kubernetes manifests wire the maintenance Deployment's `livenessProbe`
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
  notebooks every couple of minutes (so a crash or hard kill loses at most one
  interval of edits), gracefully saves + stops sessions at their lifetime or
  idle deadline — extending instead while editors are still connected — and
  destroys sandboxes left behind by expired sessions. Tune it with the
  `MARIMOHUB_SESSION_*` variables (see [configuration](./configuration.md));
  provider lifetime caps default to 2× the session lifetime as a last-resort
  backstop. With `MARIMOHUB_JOBS=on` it also runs the **job scheduler**: every
  `MARIMOHUB_JOBS_TICK_SECONDS` it fires due [notebook jobs](./jobs.md),
  dispatches queued runs under the concurrency caps, and reclaims runs past
  their deadline. Jobs are accepted but never run without this replica.

## Background loops

The maintenance replica runs these loops. Each leased loop takes its own
bucket-CAS lease per attempt, so only one replica does the work even when
several run maintenance.

| Loop                  | Interval                                                  | Lease                             | Runs when                     |
| --------------------- | --------------------------------------------------------- | --------------------------------- | ----------------------------- |
| `maintenance`         | 5 min                                                     | `_system/_maintenance.lock`       | Always                        |
| `session_lifecycle`   | `MARIMOHUB_SESSION_SWEEP_INTERVAL_SECONDS` (default 60 s) | `_system/_session_lifecycle.lock` | Session lifetimes are enabled |
| `warm_pool`           | 5 s (5 min while warm pools are disabled)                 | `_system/_warm_pool.lock`         | A warm pool is configured     |
| `job_scheduler`       | `MARIMOHUB_JOBS_TICK_SECONDS` (default 60 s)              | `_system/_jobs.lock`              | `MARIMOHUB_JOBS=on`           |
| `preview_preparation` | 15 s                                                      | None                              | Source control is configured  |

Each attempt has a deadline of `max(3 × interval, 10 min)`, covering lease
acquisition, the work, and lease release. When an attempt passes its deadline,
the runner aborts it, logs `<loop>_stalled` (`level: error`, with `holder`,
`deadline_ms`, and `duration_ms`), and starts no new attempt for that loop until
the abandoned work settles, so a loop never has two writers. When the work
settles, the runner logs `<loop>_recovered` (`level: debug`), discards the late
result, and the next tick retries. Skipped attempts (another replica holds the
lease, or there is nothing to do) count as successes.

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

## Reclaim a stuck editor sandbox

While a notebook's previous editor session is still being cleaned up, starting
a new editor returns `409 EDIT_SESSION_RETIRING` and the notebook shows a
cleanup message with a **Retry** button. The lifecycle sweep, the 5-minute
maintenance cycle, or **Stop** normally finishes the cleanup; see
[Editor sessions](./editor-sessions.md#session-cleanup) for the grace periods.

Super admins can force it from **Admin → Runtime → Editors → Reclaim session**
(`POST /api/v1/admin/runtime/projects/{pid}/sessions/{sid}/reclaim`, optional
body `{ "save": false }`; `save` defaults to `true`). A successful reclaim
returns `200` with
`{ "success": true, "data": { "reclaimed": true, "saved": true } }` (`saved` is
`false` when nothing was saved).

| Response | Reason                                                                 | Action                                               |
| -------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `409`    | `not_terminal`                                                         | Stop the session first.                              |
| `409`    | `provision_grace`, `teardown_grace`, `kernel_active`                   | Wait for the grace period or for editors to leave.   |
| `409`    | `attachment_unsupported`                                               | Reclaim without saving; unsaved edits are discarded. |
| `503`    | `attachment_failed`, `kernel_unreachable`, `destroy_failed`, `timeout` | Transient; retry after `Retry-After`.                |

Runtime inspection shows `reclaimable` and `reclaim_blocked_reason` on each
editor row. Each attempt writes a `session.reclaim` audit event with the actor,
`save_requested`, `reclaimed`, and `saved` or the blocking reason.

**Known limitation:** providers that cannot attach to an existing sandbox
(currently Cloudflare) cannot save a retired session. Sessions that may hold
unsaved edits stay until a super admin reclaims them without saving.

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

::: tip Notebook history is already in the store
Per-notebook version history is kept in object storage, so bucket backups
capture it automatically — no separate export.
:::

## Upgrades

Before upgrading from 0.4.8, check `MARIMOHUB_SESSION_CONNECTION_AWARE` and
`MARIMOHUB_AUTOMATIC_THUMBNAILS`. Both now accept only `true` or `false`, ignoring
case and surrounding whitespace. Unset or blank values keep the default, `true`.
Other values, including `1`, `0`, `yes`, and `on`, now stop startup with a
configuration error. Previously, these values all enabled the feature. Replace
them with the explicit boolean that matches your intended behavior.

HTTP create retries with older idempotency records now return `422` instead of
replaying an unverifiable response or creating a duplicate. Check the original
operation before using a new key.

The image and Helm chart are released together on every `v*` tag (chart version,
`appVersion`, and image tag all match), so pinning a chart version pins
everything.

```bash
helm upgrade marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version <VERSION> -n marimohub -f values.yaml
helm rollback marimohub -n marimohub     # revert
helm history marimohub -n marimohub      # what's running
```

Replace `<VERSION>` with a tag from
[GitHub Releases](https://github.com/marimo-team/marimohub/releases), without
the leading `v`. See [Deploying with Helm](/deploying/helm). The API tier is
stateless. Changes to the editor-claim protocol require the drain procedure in
[Editor sessions → Changing the sharing mode](/editor-sessions#changing-the-sharing-mode).

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
Requests that reuse an existing session or fail before provisioning do not emit this event.
The `client` field groups requests by route and authentication:

| `client` | Meaning                                                                                 |
| -------- | --------------------------------------------------------------------------------------- |
| `mcp`    | Requests through `/mcp`, regardless of credential type.                                 |
| `web`    | REST requests with SSO or development authentication.                                   |
| `cli`    | REST requests with token authentication, including API scripts and other token callers. |

When present, `session_id` identifies the session record and `provision_error_code` identifies a provisioning failure.

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

The server records RED metrics per request — the `http.server.request.duration`
histogram (labelled by route, method, and status code) and the
`http.server.active_requests` gauge — plus domain signals: catalog CAS
contention (`catalog.cas.*`), session and reaper activity (`sessions.*`),
snapshot growth (`snapshots.*`, `maintenance.*`), and notebook job activity
(`jobs.*`: fires, dispatches, transitions, CAS conflicts, watchdog timeouts,
retries, and the active-run gauge). Object browsing adds operation
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
