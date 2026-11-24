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
UI, the Node maintenance scheduler or Cloudflare `scheduled()` handler, and the
`job.*` [project alert](./project-alerts.md) kinds. While off, the jobs routes answer
`404`, `GET /api/v1/capabilities` reports `jobs.available: false`, the UI hides
its entry points, and stored job definitions and run history are left untouched
so the feature can be turned back on without loss.

## App-consumer execution and history

Editors configure two independent settings in **New job** or **Edit job**, or through the API:

| Setting                                                    | Default | Effect                                                                                                                                              |
| ---------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Allow app users to run this job** (`consumer_execution`) | Off     | Lets authorized app users start runs.                                                                                                               |
| **Run history** (`consumer_history`)                       | Private | Limits history to the person who started the run and editors. Shared also exposes summaries and completed parameters to other authorized app users. |

Disabling app execution does not change history sharing.

Scoped credentials need `job.trigger` plus source access (`app.read` or `project.read`) to invoke an opted-in job.
The `run` token preset includes `job.trigger`; the `read` preset does not.
Existing `notebook.write` credentials retain editor execution without a separate read grant.
Signed-in consumers still need current source access and the job's execution opt-in.

Shared summaries include run/source identity, status, triggerer, timestamps, tags,
and completed parameters. Active parameters, diagnostics, and rendered output stay
restricted to the triggerer and editors. Raw logs remain editor-only.

Every request checks current project and notebook access. Disabling sharing restricts
future reads but cannot recall viewed data. Deleted sources are unavailable.
Tags only filter history: matching tags never grant access or combine job policies.

To reuse completed inputs, submit their parameters to the current job.
The new run records the current caller and source version. It continues after the
initiating visit closes. Applications own progress displays; external links grant no external access.

## Triggering jobs from an app

App code can run opted-in jobs as the signed-in visitor with the `marimohub.jobs` helper.
It needs no API token. It works in published apps with proxy exposure and browser SSO or
development sign-in.

```python
from marimohub.jobs import Jobs

jobs = Jobs()
job_id = "job-7h2k9qm4xz7rp3w8"
run = jobs.trigger(job_id, parameters={"value": "42"}, tags={"app": "demo"})
active = jobs.list_active_runs(job_id)
page = jobs.list_project_runs(tag_key="app", tag_value="demo", limit=20)
```

Create `Jobs()` inside each visitor's session. The job must have `consumer_execution` on.
[Jobs from app code](https://github.com/marimo-team/marimohub/blob/main/development_docs/app-jobs.md)
lists the methods and the credential rules.
[`examples/app-jobs/`](https://github.com/marimo-team/marimohub/tree/main/examples/app-jobs) is a
complete app.

## Create a schedule

1. Open **Jobs & schedules** from the notebook’s actions menu.
2. Select **New job** and enter a name.
3. Enable **Run on a schedule**, then enter a cron expression and time zone.
4. Select **Create job**.

<figure class="doc-screenshot doc-screenshot--narrow">
  <a href="/screenshots/job-schedule.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: New job form with a weekday cron schedule at 09:00 UTC (new tab)">
    <img src="/screenshots/job-schedule.png" alt="New job form with a weekday cron schedule at 09:00 UTC" width="670" height="334" loading="lazy" decoding="async" />
  </a>
  <figcaption>This schedule runs the notebook at 09:00 UTC, Monday through Friday.</figcaption>
</figure>

## How it works

- **A job belongs to a notebook.** Open **Jobs & schedules** from the notebook's
  actions menu. On the notebook page, it is in the notebook menu. Click the
  notebook title to open that menu. Define jobs there: a
  name, an optional cron schedule with an IANA time zone, parameters, a
  timeout, a retry policy, and what to do when the previous run is still active.
  A job without a schedule is manual-only.
- **Runs pin notebook source, not every local workspace file.** Each run uses a
  fresh copy-only sandbox (never a bucket mount) and records the notebook version
  it started from. Git-synced notebooks copy the complete immutable workspace of
  that version. Local notebooks copy the current workspace, then overlay the
  pinned version's entrypoint (`notebook.py` unless imported with a different
  entry file) and `pyproject.toml`; other local workspace files
  therefore reflect their values when execution starts. The rendered HTML and
  captured stdout/stderr live under the run only. They are **not** notebook
  versions and never advance the notebook's head.
- **Parameters reach the notebook as `mo.cli_args()`.** Each `key=value`
  becomes `--key value` after `--` on the run command, so
  `mo.cli_args().get("region")` reads it. Values are strings and are never
  shell-interpolated. A manual run can override the job's stored parameters
  for that run only. Parameters are visible to project members who can read the
  job and run history, so they must not contain secrets.
- **Node dispatches from the maintenance replica.** The replica running
  `MARIMOHUB_RUN_MAINTENANCE=true` evaluates schedules every
  `MARIMOHUB_JOBS_TICK_SECONDS`, dispatches queued runs under the concurrency
  caps, enforces run deadlines, and prunes old runs. Without that replica, a
  Node deployment accepts jobs but leaves manual triggers queued. The Cloudflare
  reference deployment instead dispatches from its platform `scheduled()`
  handler. See [Operations](./operations.md#scaling).
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
  If active run records cannot be read, the scheduler pauses new scheduled fires
  and dispatches to preserve these limits. It still enforces deadlines and
  completes finalization for readable runs.
- **Timeouts and retries.** A run past its timeout (`timeout_seconds`, default
  `MARIMOHUB_JOBS_DEFAULT_TIMEOUT_SECONDS`, capped by
  `MARIMOHUB_JOBS_MAX_TIMEOUT_SECONDS`) has its sandbox destroyed and lands
  `timed_out`. A failed or timed-out run is retried up to `max_retries` times
  after `backoff_seconds`; each attempt is its own run linked to the previous one.
- **Retention.** Run records and outputs older than
  `MARIMOHUB_JOBS_RUN_RETENTION_DAYS` are pruned by the Node maintenance cycle;
  the Cloudflare scheduled handler prunes with its fixed 30-day retention.
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

## Follow a run while it executes

With `MARIMOHUB_JOBS_LIVE_RUNS=on`, a `running` run on the **Jobs** page shows
each cell's output as the cell finishes. When the run ends, the page shows the
stored output.

The run executes under a marimo server on the sandbox's loopback interface. The
notebook still runs once, reads its parameters from `mo.cli_args()`, and stores
the same HTML output and logs.

Requirements:

- `MARIMOHUB_AUTH_SESSION_SECRET`.
- A compute backend that can reattach to a running sandbox. Cloudflare cannot.
- A sandbox image whose marimo serves the host protocol.

Without a suitable backend or image, the run uses `marimo export html` and
cannot be followed.

A live run differs from other runs:

- A cell that reads standard input fails with `EOFError`. Other runs wait for
  the timeout.
- A notebook that ends its own Python process fails with exit status 2 and no
  output. Other runs wait for the timeout.
- With `MARIMOHUB_COMPUTE_ASSET_URL` set, the stored output loads the marimo
  frontend from that origin. Keep staged versions while you retain run outputs.
  See [Shared marimo assets](./marimo-assets.md).

Limits of the live view:

- It is read-only. Table search, pagination, and other kernel calls do not work.
- It shows no code or console output. Editors read console output on the
  **Logs** tab after the run ends.
- Outputs over 4 MiB, and outputs that reference kernel-served files, appear
  only in the stored output.
- Each open view runs one short command per second in the sandbox. An API
  replica serves at most eight views of a run.

Anyone who can open the run's output can follow it. The hub rechecks access
every 10 seconds.

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

Applications can read run status through the API and recover active runs after
reconnecting. Closing a browser or app session does not cancel accepted runs.
`queued` means waiting; no queue position or start-time estimate is available.

## Queue admission and capacity

`MARIMOHUB_JOBS_MAX_QUEUED_RUNS_PER_JOB` sets each job's manual admission
threshold on Node: a positive integer, default 20. All API replicas must use
the same value. Capabilities expose it as `jobs.max_queued_runs_per_job`.

Admission counts all queued runs for the job, including schedules and retries.
Scheduled fires and automatic retries can exceed the threshold. There is no
project-wide queue limit. Lowering the threshold preserves accepted runs.

Manual submissions to one job are serialized under a distributed job claim.
A submission that waits more than about 5 seconds returns HTTP 503 `SERVICE_UNAVAILABLE`;
retry it with the same `Idempotency-Key`. At the threshold,
new submissions return HTTP 429 with `RESOURCE_EXHAUSTED`. An accepted request's
`Idempotency-Key` still replays its original run.

A caller without write access to the notebook can have at most 3 queued or running runs
per job. The next submission returns HTTP 429 `RESOURCE_EXHAUSTED` until one of them
finishes. This limit is fixed, so one app user cannot fill a job's queue.

Separate deployment and project caps bound provisioning and running runs;
accepted excess stays queued. Dispatch selects eligible runs oldest first and
skips saturated projects, without reserving a share for each project.
The `forbid` policy applies only to scheduled fires.

### Node configuration for 100 runs

Set these variables on every Node replica:

```sh
MARIMOHUB_JOBS=on
MARIMOHUB_JOBS_MAX_QUEUED_RUNS_PER_JOB=100
MARIMOHUB_JOBS_MAX_CONCURRENT_RUNS=100
MARIMOHUB_JOBS_MAX_CONCURRENT_RUNS_PER_PROJECT=100
```

Use durable shared storage and enable `MARIMOHUB_RUN_MAINTENANCE=true` on the
designated maintenance replica. Keep dispatch under the maintenance lease.

Set `timeout_seconds: 14400` on jobs that need four hours. The default remains
1800 seconds (30 minutes); 14400 is the ceiling. Timeouts start at dispatch,
include provisioning, and exclude queue waiting.

This configuration accepts 100 submissions to an empty job before a scheduler
tick and lets one project use all execution capacity. For multiple projects,
choose a lower project cap to leave capacity for others. See
[Configuration](./configuration.md#jobs) for the defaults.

Production capacity is unmeasured: automated tests use test doubles, and no staged
compute load test was run. Size compute quotas, CPU, memory, and storage throughput
for the intended notebooks before using this configuration in production.

## Who can do what

| Action                            | Consumers (`app-user`, `viewer`)  | `editor`, `manager`, `admin` |
| --------------------------------- | --------------------------------- | ---------------------------- |
| See job definitions               | Yes                               | Yes                          |
| See run history                   | Own runs, or shared history       | Yes                          |
| Open rendered output              | Own runs                          | Yes                          |
| Follow a running run              | Own runs                          | Yes                          |
| Create, configure, or delete jobs | No                                | Yes                          |
| Trigger a run                     | With `consumer_execution` enabled | Yes                          |
| Cancel a run or read raw logs     | No                                | Yes                          |

All access requires current project and notebook authorization.
Raw logs can contain environment values and tracebacks.

> **Security note.** A run executes the notebook's code with the project's
> resolved [integration secrets](./integration-secrets.md) and federated
> credentials injected — exactly what an app session carries — regardless of
> who triggers it or when the schedule fires. The credentials are attributed to
> the manual triggerer, or to the job's author for scheduled runs. Treat a job
> definition as you would a shared app. Treat run `parameters` from consumers as
> untrusted input: a consumer can send them through the REST API and skip the app's
> controls. Validate every parameter the notebook reads.

## Notifications

With [project alerts](./project-alerts.md) enabled, a job can send
`job.run.failed` (once retries are exhausted) and `job.run.succeeded` events to
the project's alert destinations that subscribe to them. The payload names the
job, run, status, attempt, and sanitized error code.

## MCP

With MCP enabled and `MARIMOHUB_JOBS=on`, agents can list, create, schedule, and run jobs.
Run tools support polling or bounded waits with optional SSE progress notifications.
See [MCP jobs](./mcp.md#run-and-schedule-jobs) for inputs and examples.

## API

All routes are under `/api/v1/projects/{pid}/notebooks/{nid}/jobs` and use the
standard envelope. Job creation and manual run triggers accept an
`Idempotency-Key`.

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
| `POST`   | `/{jid}/runs/{rid}/follow` | Live view of a running run; see below.                   |
| `GET`    | `/{jid}/runs/{rid}/logs`   | Captured logs, raw `text/plain`, editor-only.            |

The CLI exposes the same operations under `jobs …`, except `follow`.

`follow` returns `{ html, expires_at }` for a `running` run with `live: true`.
The HTML embeds a credential for the caller and the run. Show it in a frame with
`sandbox="allow-scripts"`, and request a new view before `expires_at`. Any other
run answers 409 with code `RUN_NOT_FOLLOWABLE`. So does a live run in its first
seconds; retry while it is running.

## Configuration

The `MARIMOHUB_JOBS_*` variables and their defaults are listed in
[Configuration](./configuration.md#jobs). On Node, the tuning variables apply only while
`MARIMOHUB_JOBS=on`. Jobs grant editors nothing an edit session does not; unattended cost is
bounded by the caps and timeouts, and a deployment can turn the feature off at any time.

::: tip Cloudflare Workers
The Workers reference deployment reads the same `MARIMOHUB_JOBS` toggle from
its wrangler vars and ticks the scheduler from its five-minute cron trigger, so
schedules finer than five minutes are Node-only, and a run is bounded by the
Workers invocation limits. It ignores the tuning variables and uses their
defaults, except that tick cadence comes from the five-minute platform trigger.
:::
