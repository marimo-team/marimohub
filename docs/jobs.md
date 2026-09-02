---
description: Run notebooks headlessly on a cron schedule or on demand, with a durable run history.
---

# Notebook jobs

A **job** runs a notebook to completion without a browser — on a cron schedule,
or on demand from the UI, API, or CLI — and keeps a durable **run history** with
the rendered outputs. marimo's deterministic DAG execution makes a notebook a
good batch unit: a run executes `marimo export html` against saved notebook
source and stores the result beside the run record. Editing, apps, and
version history are untouched: a run never writes anything back to the
notebook.

## Enabling jobs

Jobs are **off by default**. Set `MARIMOHUB_JOBS=on` to enable the job API and
UI, the scheduler loop on the maintenance replica, and the `job.*`
[project alert](./project-alerts.md) kinds. While off, the jobs routes answer
`404`, `GET /api/v1/capabilities` reports `jobs.available: false`, the UI hides
its entry points, and stored job definitions and run history are left untouched
so the feature can be turned back on without loss.

## How it works

- **A job belongs to a notebook.** Open **Jobs & schedules** from the notebook's
  actions menu (or the calendar icon on the notebook page) to define jobs: a
  name, an optional cron schedule with an IANA time zone, parameters, a
  timeout, a retry policy, and what to do when the previous run is still active.
  A job without a schedule is manual-only.
- **Runs pin notebook source, not every local workspace file.** Each run uses a
  fresh copy-only sandbox (never a bucket mount) and records the notebook version
  it started from. Git-synced notebooks copy the complete immutable workspace of
  that version. Local notebooks copy the current workspace, then overlay the
  pinned version's `notebook.py` and `pyproject.toml`; other local workspace files
  therefore reflect their values when execution starts. The rendered HTML and
  captured stdout/stderr live under the run only. They are **not** notebook
  versions and never advance the notebook's head.
- **Parameters reach the notebook as `mo.cli_args()`.** Each `key=value`
  becomes `--key value` after `--` on the export command, so
  `mo.cli_args().get("region")` reads it. Values are strings and are never
  shell-interpolated. A manual run can override the job's stored parameters
  for that run only. Parameters are visible to project members who can read the
  job and run history, so they must not contain secrets.
- **The scheduler lives on the maintenance replica.** The replica running
  `MARIMOHUB_RUN_MAINTENANCE=true` evaluates schedules every
  `MARIMOHUB_JOBS_TICK_SECONDS`, dispatches queued runs under the concurrency
  caps, enforces run deadlines, and prunes old runs. **Without a maintenance
  replica jobs are accepted but never run** — manual triggers stay `queued`.
  See [Operations](./operations.md#scaling).
- **Exactly once, never backfilled.** Every scheduled fire claims an
  occurrence record keyed by its UTC minute, so two replicas evaluating the same
  schedule cannot both fire it. After an outage only the latest missed
  occurrence within `MARIMOHUB_JOBS_CATCHUP_WINDOW_SECONDS` runs; a three-day
  gap produces one catch-up run, not thousands.
- **Concurrency.** `MARIMOHUB_JOBS_MAX_CONCURRENT_RUNS` bounds runs holding a
  sandbox across the deployment and `MARIMOHUB_JOBS_MAX_CONCURRENT_RUNS_PER_PROJECT`
  bounds each project's share; further runs wait in the queue, oldest first.
  Per job, the default policy **skips** a scheduled fire while the previous run
  is still active (the skip is recorded in the history); choose "run anyway" to
  let runs overlap.
- **Timeouts and retries.** A run past its timeout (`timeout_seconds`, default
  `MARIMOHUB_JOBS_DEFAULT_TIMEOUT_SECONDS`, capped by
  `MARIMOHUB_JOBS_MAX_TIMEOUT_SECONDS`) has its sandbox destroyed and lands
  `timed_out`. A failed or timed-out run is retried up to `max_retries` times
  after `backoff_seconds`; each attempt is its own run linked to the previous one.
- **Retention.** Run records and outputs older than
  `MARIMOHUB_JOBS_RUN_RETENTION_DAYS` are pruned by the maintenance cycle.
  Deleting a job removes its history immediately; soft-deleting a notebook or
  project cancels its active runs, and the hard-delete sweep reclaims the rest.
- **Compute image and profile.** A run provisions exactly as a session start
  would: the notebook's [base image](./sandbox-image.md) choice (falling back to
  the deployment default when that image is no longer offered) and its
  [compute profile](./compute.md) when the deployment lets editors override
  (`MARIMOHUB_COMPUTE_PROFILE_OVERRIDE=editors`), else the default profile. The
  applied `image`, `compute_profile`, and `compute_resources` are recorded on
  the run for provenance, like on a session.
- **Audit events.** `job.create`, `job.update`, and `job.delete` land in the
  project [audit log](./operations.md) with the actor; `job.run.trigger` and
  `job.run.cancel` record who started or stopped a run; `job.run.finish`
  records every outcome (status, attempt, exit code, sanitized error code,
  duration), attributed to the manual triggerer or to `system` for scheduled
  runs.

## Run states

| Status         | Meaning                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| `queued`       | Waiting for the scheduler to dispatch it (or for a retry's backoff to elapse).         |
| `provisioning` | A sandbox is being created and loaded.                                                 |
| `running`      | `marimo export html` is executing.                                                     |
| `succeeded`    | Every cell ran; the rendered output is available.                                      |
| `failed`       | A cell raised, the export could not run, or the sandbox could not be prepared.         |
| `timed_out`    | The run exceeded its timeout and was reclaimed.                                        |
| `cancelled`    | Cancelled by an editor; its sandbox was destroyed.                                     |
| `skipped`      | A scheduled fire declined because the previous run was still active (`forbid` policy). |

When a cell raises, marimo still writes the rendered HTML, so a `failed` run
usually has output showing where it stopped. The run's `error` carries a
sanitized code (`NOTEBOOK_FAILED`, `RUN_TIMED_OUT`, …) — never provider
messages or secrets. Editors can read the captured logs.

## Who can do what

| Action                               | `viewer` | `editor` | `manager` | `admin` |
| ------------------------------------ | :------: | :------: | :-------: | :-----: |
| See jobs and run history             |    x     |    x     |     x     |    x    |
| Open a run's rendered output         |    x     |    x     |     x     |    x    |
| Create, edit, enable, or delete jobs |          |    x     |     x     |    x    |
| Run a job now or cancel a run        |          |    x     |     x     |    x    |
| Read a run's stdout/stderr logs      |          |    x     |     x     |    x    |

Triggering a job starts a kernel, so it takes the same editor gate as starting
a session. Run history and outputs follow the static-snapshot posture (viewers
can see rendered documents); logs are editor-only because stdout can echo
environment values and tracebacks.

> **Security note.** A run executes the notebook's code with the project's
> resolved [integration secrets](./integration-secrets.md) and federated
> credentials injected — exactly what an app session carries — regardless of
> who triggers it or when the schedule fires. The credentials are attributed to
> the manual triggerer, or to the job's author for scheduled runs. Treat a job
> definition as you would a shared app.

## Notifications

With [project alerts](./project-alerts.md) enabled, a job can send
`job.run.failed` (once retries are exhausted) and `job.run.succeeded` events to
the project's alert destinations that subscribe to them. The payload names the
job, run, status, attempt, and sanitized error code.

## API

All routes are under `/api/v1/projects/{pid}/notebooks/{nid}/jobs` and use the
standard envelope; `POST` routes accept an `Idempotency-Key`.

| Method   | Path                       | Notes                                                    |
| -------- | -------------------------- | -------------------------------------------------------- |
| `GET`    | `/`                        | List jobs, oldest first, with cursor pagination.         |
| `POST`   | `/`                        | Create; validates cron/time zone/timeout.                |
| `GET`    | `/{jid}`                   | Read (ETag = `updated_at`).                              |
| `PATCH`  | `/{jid}`                   | Partial update; `null` clears an optional field.         |
| `DELETE` | `/{jid}`                   | Requires `If-Match`; cancels active runs, then deletes.  |
| `POST`   | `/{jid}/runs`              | Run now; body `{ "parameters": {…} }` overrides per run. |
| `GET`    | `/{jid}/runs`              | Run history, newest first, paginated.                    |
| `GET`    | `/{jid}/runs/{rid}`        | One run.                                                 |
| `POST`   | `/{jid}/runs/{rid}/cancel` | Cancel (runs are history; never deleted individually).   |
| `GET`    | `/{jid}/runs/{rid}/html`   | Rendered output, raw `text/html`.                        |
| `GET`    | `/{jid}/runs/{rid}/logs`   | Captured logs, raw `text/plain`, editor-only.            |

The CLI exposes the same operations under `jobs …`.

## Configuration

| Variable                                         | Default | Meaning                                                    |
| ------------------------------------------------ | ------- | ---------------------------------------------------------- |
| `MARIMOHUB_JOBS`                                 | `off`   | Turns the feature on (`on`) or off (`off`).                |
| `MARIMOHUB_JOBS_TICK_SECONDS`                    | `60`    | Scheduler interval on the maintenance replica.             |
| `MARIMOHUB_JOBS_MAX_CONCURRENT_RUNS`             | `5`     | Deployment-wide cap on runs holding a sandbox.             |
| `MARIMOHUB_JOBS_MAX_CONCURRENT_RUNS_PER_PROJECT` | `2`     | Per-project share of the cap.                              |
| `MARIMOHUB_JOBS_MAX_PER_NOTEBOOK`                | `5`     | Job definitions per notebook (`0` = unlimited).            |
| `MARIMOHUB_JOBS_DEFAULT_TIMEOUT_SECONDS`         | `1800`  | Run deadline when the job sets none.                       |
| `MARIMOHUB_JOBS_MAX_TIMEOUT_SECONDS`             | `14400` | Ceiling on a job's `timeout_seconds`.                      |
| `MARIMOHUB_JOBS_RUN_RETENTION_DAYS`              | `30`    | How long run records and outputs are kept.                 |
| `MARIMOHUB_JOBS_CATCHUP_WINDOW_SECONDS`          | `600`   | How stale a missed occurrence may be and still fire, once. |

The remaining variables apply only while `MARIMOHUB_JOBS=on`. Jobs grant
editors nothing an edit session does not; unattended cost is bounded by the
caps and timeouts, and a deployment can turn the feature off at any time.

::: tip Cloudflare Workers
The Workers reference deployment reads the same `MARIMOHUB_JOBS` toggle from
its wrangler vars and ticks the scheduler from its five-minute cron trigger, so
schedules finer than five minutes are Node-only, and a run is bounded by the
Workers invocation limits.
:::

See [Configuration](./configuration.md) for the full reference.
