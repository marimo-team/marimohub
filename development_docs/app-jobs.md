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

Credentials cover jobs in the app's notebook. Every call checks live access and app admission.
Triggers also check the current job execution policy.
Credentials expire after five minutes. Refresh ends after one hour or at the original identity expiry, whichever occurs first.
Reopen the app after refresh expires.

Ending the user's last admitted visit revokes its credentials without cancelling accepted runs.
A fresh visit can recover the same user's active runs.
