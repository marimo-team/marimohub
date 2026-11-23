# Jobs from app code

`marimohub.jobs` runs jobs as the signed-in visitor without API tokens.
It supports published apps with proxy exposure and browser SSO or development authentication.
Direct subdomain exposure and preview apps are not supported.

Enable consumer execution on each job that the app calls.
Create `Jobs` inside the visitor's marimo session:

```python
from marimohub.jobs import Jobs

jobs = Jobs()
job_id = "job-7h2k9qm4xz7rp3w8"

# Recover an active run before offering another submission.
runs = jobs.list_active_runs(job_id)
run = runs[0] if runs else jobs.trigger(job_id, parameters={"value": "42"})
run = jobs.get_run(job_id, run["run_id"])
```

`Jobs()` reads the current [marimo request](https://docs.marimo.io/api/app/) when constructed.
For an explicit request, use `Jobs.from_request(mo.app_meta().request)`.

Poll with `get_run` in a separate cell or callback.
Do not share `Jobs` through a module global or environment variable.

Calls are synchronous, with a 30-second timeout per HTTP request.
The helper refreshes credentials before each operation and never retries an uncertain submission.
`list_active_runs` and `get_run` return only the visitor's runs, including for project editors.
Submission tags never grant access.

Trigger and own-run operations cover jobs in the app's notebook.
Project history is a separate read-only operation. Every call checks live access and app admission.
Triggers also check the current job execution policy.
Credentials expire after five minutes. Refresh ends after one hour or at the original identity expiry, whichever occurs first.
Reopen the app after refresh expires.

Ending the user's last admitted visit revokes its credentials without cancelling accepted runs.
A fresh visit can recover the same user's active runs.

## Project history

`jobs.list_history(tag_key="app", tag_value="demo", limit=20)` returns
`{"items": [...], "next_cursor": ...}`. Each call scans one bounded page,
at most 500 entries. Pass the cursor into the next call with the same filters.
An empty `items` array does not mean the scan is complete: continue when
`next_cursor` is not null. The helper never loads subsequent pages automatically.

Optional filters match the project REST API: an exact `tag_key` / `tag_value`
pair, `status` (a run status or `"active"`), and either `triggered_by`
or `triggered_by_me=True`. Restart without a cursor to refresh live statuses.

History can include other notebooks and source versions in the admitted app's
project. Each source's live access and job policy are checked on every call.
Owners and editors receive the REST API's full public run projection; other
consumers see summaries only when `consumer_history="shared"`. Shared summaries
exclude active parameters and owner diagnostics. Raw logs are never included.
Private runs remain hidden from other consumers, even when tags match.

Only this history operation crosses notebook boundaries. Trigger, get_run, and
list_active_runs remain limited to the app notebook. A tag or cursor grants no
access. Leaving the app, revoked source access, or disabling sharing affects
subsequent calls.

See the [two-consumer example](../examples/app-jobs/README.md).
