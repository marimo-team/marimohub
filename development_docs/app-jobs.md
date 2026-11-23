# Jobs from app code

`marimohub.jobs` runs jobs as the signed-in visitor without API tokens.
It supports published apps with proxy exposure and browser SSO or development authentication.
Preview apps and direct subdomain exposure are not supported.

Enable consumer execution on each job that the app calls.
Create `Jobs` inside each visitor's marimo session:

```python
from marimohub.jobs import Jobs

jobs = Jobs()
job_id = "job-7h2k9qm4xz7rp3w8"

# Recover an active run before offering another submission.
runs = jobs.list_active_runs(job_id)
run = runs[0] if runs else jobs.trigger(job_id, parameters={"value": "42"})
run = jobs.get_run(job_id, run["run_id"])
```

`Jobs()` reads the current [marimo request](https://docs.marimo.io/api/app/).
`Jobs.from_request(request)` accepts an explicit request.
Keep the client inside the visitor session. Poll with `get_run` in a separate cell or callback.

`trigger`, `get_run`, and `list_active_runs` are limited to the app notebook.
The two read methods return only the visitor's runs, even for project editors.

## Project history

`jobs.list_history(tag_key="app", tag_value="demo", limit=20)` reads across notebooks
and source versions in the admitted app's project.
It returns `items` and `next_cursor`.

Each call scans at most `limit` entries (default 100, maximum 500).
The helper never loads another page automatically.
If `next_cursor` is not null, pass it into the next call with the same filters.
This applies even when `items` is empty.

Optional filters match the project REST API:

- `tag_key` and `tag_value`: an exact pair.
- `status`: a run status, or `"active"` for queued, provisioning, and running runs.
- `triggered_by` or `triggered_by_me=True`: an exact user ID or the current visitor.

Restart without a cursor to refresh live statuses.

Every page checks live source access and job policy.
Run owners and authorized editors receive the full public run fields.
Other consumers receive summaries only when `consumer_history="shared"`.
These summaries exclude active parameters and owner diagnostics.
Completed parameters are visible in shared summaries. Do not put secrets in parameters.
History never includes raw logs. Tags and cursors grant no access.

See the [two-consumer example](../examples/app-jobs/README.md).

## Credentials

Calls are synchronous, with a 30-second timeout per HTTP request.
The helper refreshes credentials before each operation and does not retry failed calls.
Every call checks live access and app admission. Triggers also check the execution policy.

Credentials expire after five minutes.
Refresh ends after one hour or at the original identity expiry, whichever occurs first.
Reopen the app after refresh expires.

Ending the last admitted visit revokes credentials without cancelling accepted runs.
A fresh visit can recover the same visitor's active runs.
Access revocation and changes to sharing policy take effect on subsequent calls.
