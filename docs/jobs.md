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

## Event triggers

### Authentication

The **Trigger jobs** PAT preset grants `job.trigger` and `project.read`.
External identity providers can use the equivalent `marimohub:trigger` scope.
These credentials permit manual runs, webhook triggers, and the MCP `run_job`
tool without notebook edits. The owner still needs editor access to the project.

PAT grants select projects, not individual jobs. Runs record the caller in
`triggered_by`. [PAT expiry and revocation](./api-tokens.md#revoke-a-token) apply,
including the 30-second revocation delay on other replicas.

### Send an event

1. In **API tokens**, create a token with the **Trigger jobs** preset.
2. Limit the token to the target project.
3. Set an expiry.
4. Copy the trigger URL from the saved job.

Send a POST request to
`/api/v1/projects/{pid}/notebooks/{nid}/jobs/{jid}/trigger`
with `Authorization: Bearer <PAT>`. This endpoint uses normal API authentication
and CSRF checks.

The JSON body is optional:

| Field             | Behavior                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `parameters`      | Replaces the stored parameter map for this run.                                                      |
| `event`           | JSON object, at most 16 KiB encoded as UTF-8. Replaces `parameters.event` with its serialized value. |
| `idempotency_key` | Identifies the event for replay. Scoped to the caller and job.                                       |

The notebook reads the event with `json.loads(mo.cli_args()["event"])`.
The response is HTTP 202 with
`{"success":true,"data":{"run_id":"run_…","queued":true}}`.
Runs appear as **Webhook** in the history.

- With `concurrency_policy: "forbid"`, webhook runs wait for earlier runs of the same job.
- Each job permits 60 webhook admissions per ten minutes across callers and replicas.
- Each job permits 20 queued runs. Either limit returns HTTP 429.
- Disabled or deleted jobs reject requests, including replay, with HTTP 404.

For the same caller and job, a repeated key returns the original run without
another rate-limit admission. Receipts normally last 24 hours.
A replacement PAT for the same owner can replay the request.
A different body returns HTTP 422. JSON property order does not affect replay.
Every request, including replay, requires current authorization.

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $HUB_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"upload-123","event":{"key":"incoming/data.csv"}}' \
  "$HUB_TRIGGER_URL"
```

For **S3 events**, configure an S3 event consumer, such as Lambda, to make this
request after an upload. Send the object key, version, and event ID in the body.
Use a stable event ID as the idempotency key. Direct SNS subscription requests
require a relay that handles the SNS protocol and adds the bearer credential.

For **GitHub Actions**, store the URL and token as repository secrets:

```yaml
- name: Trigger notebook job
  env:
    HUB_TRIGGER_URL: ${{ secrets.HUB_TRIGGER_URL }}
    HUB_API_TOKEN: ${{ secrets.HUB_API_TOKEN }}
  run: |
    curl --fail-with-body -X POST \
      -H "Authorization: Bearer $HUB_API_TOKEN" \
      -H 'Content-Type: application/json' \
      -d "{\"idempotency_key\":\"github-$GITHUB_RUN_ID\"}" \
      "$HUB_TRIGGER_URL"
```

For **GitLab CI**, store the same variables as masked CI variables:

```yaml
trigger_notebook:
  script:
    - >-
      curl --fail-with-body -X POST
      -H "Authorization: Bearer $HUB_API_TOKEN"
      -H 'Content-Type: application/json'
      -d "{\"idempotency_key\":\"gitlab-$CI_PIPELINE_ID\"}"
      "$HUB_TRIGGER_URL"
```

### Job chaining

Use **Choose downstream jobs** in the job form, or set `chain` through the API:

```json
{
	"chain": {
		"on_success": [{ "notebook_id": "nb-…", "job_id": "job-…" }],
		"on_failure": [{ "notebook_id": "nb-…", "job_id": "job-…" }]
	}
}
```

Each outcome permits up to five unique targets in the same project.
Saving requires `job.trigger` access on each target notebook.
Direct self-references are invalid. Deleted or disabled targets do not run.

Failure chains start after the final failed attempt. Cancelled and skipped runs
do not start chains. Chains stop after eight downstream steps.
Targets with full queues, invalid parameters, or active runs under the same root produce skipped runs.
Each chained run records its upstream run, root run, and depth.

The target receives `parameters.upstream` as a JSON string with `job_id`,
`run_id`, and `status`. It replaces any stored `upstream` value.
Read it with `json.loads(mo.cli_args()["upstream"])`.

## How it works

- **A job belongs to a notebook.** Open **Jobs & schedules** from the notebook's
  actions menu. On the notebook page, it is in the notebook menu. Click the
  notebook title to open that menu. Define jobs there: a
  name, an optional cron schedule with an IANA time zone, parameters, a
  timeout, a retry policy, and what to do when the previous run is still active.
  A job without a schedule can run manually, through a webhook, or through a chain.
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
  becomes `--key value` after `--` on the export command, so
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
  duration), attributed to the manual or webhook caller, or to `system` for scheduled
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
> the manual or webhook caller, or to the job's author for scheduled and chained runs. Treat a job
> definition as you would a shared app.

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
| `GET`    | `/{jid}/runs/{rid}/logs`   | Captured logs, raw `text/plain`, editor-only.            |

The CLI exposes the same operations under `jobs …`.

## Configuration

| Variable                                         | Default | Meaning                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------- |
| `MARIMOHUB_JOBS`                                 | `off`   | Turns the feature on (`on`) or off (`off`).                           |
| `MARIMOHUB_JOBS_TICK_SECONDS`                    | `60`    | Node only: scheduler interval on the maintenance replica.             |
| `MARIMOHUB_JOBS_MAX_CONCURRENT_RUNS`             | `5`     | Node only: deployment-wide cap on runs holding a sandbox.             |
| `MARIMOHUB_JOBS_MAX_CONCURRENT_RUNS_PER_PROJECT` | `2`     | Node only: per-project share of the cap.                              |
| `MARIMOHUB_JOBS_MAX_PER_NOTEBOOK`                | `5`     | Node only: job definitions per notebook (`0` = unlimited).            |
| `MARIMOHUB_JOBS_DEFAULT_TIMEOUT_SECONDS`         | `1800`  | Node only: run deadline when the job sets none.                       |
| `MARIMOHUB_JOBS_MAX_TIMEOUT_SECONDS`             | `14400` | Node only: ceiling on a job's `timeout_seconds`.                      |
| `MARIMOHUB_JOBS_RUN_RETENTION_DAYS`              | `30`    | Node only: how long run records and outputs are kept.                 |
| `MARIMOHUB_JOBS_CATCHUP_WINDOW_SECONDS`          | `600`   | Node only: how stale a missed occurrence may be and still fire, once. |

On Node, the tuning variables apply only while `MARIMOHUB_JOBS=on`. Jobs grant
editors nothing an edit session does not; unattended cost is bounded by the
caps and timeouts, and a deployment can turn the feature off at any time.

::: tip Cloudflare Workers
The Workers reference deployment reads the same `MARIMOHUB_JOBS` toggle from
its wrangler vars and ticks the scheduler from its five-minute cron trigger, so
schedules finer than five minutes are Node-only, and a run is bounded by the
Workers invocation limits. It ignores the tuning variables in the table and
uses their listed defaults, except that tick cadence comes from the five-minute
platform trigger.
:::

See [Configuration](./configuration.md) for the full reference.
