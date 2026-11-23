# Shared app job history

Import [app.py](app.py) into a hosted notebook with proxy exposure and jobs enabled.
The hosted runtime supplies `marimohub.jobs`.
See [Jobs from app code](../../development_docs/app-jobs.md) for access rules and credential limits.

1. Create two jobs in this notebook with `consumer_execution=true`.
   Set `consumer_history="shared"` on one and `consumer_history="private"` on the other.
2. Add Alice and Bob as project app-users.
   Open the published app in separate signed-in browser sessions.
3. As Alice, enter the shared job ID and submit.
   Wait for success.
   As Bob, click **Refresh history and my active runs**.
   The shared history includes Alice's completed run.
4. Edit and save the notebook, then reopen the published app.
   Keep the tag `app=shared-history-demo-v1` unchanged.
   Submit as Bob.
   Both consumers can read completed runs with two distinct `source_version_id` values.
5. As Alice, submit with the private job ID.
   Bob cannot see this run, despite the matching tag.
   Alice can see her own run.
6. While runs are queued or running, refresh both sessions.
   **My active runs** shows only the current visitor's runs across versions.
   Each Next button loads one page.
   If an empty page has an enabled Next button, continue to the next page.
7. Disable sharing on the shared job.
   Refresh Bob's view: Alice's runs disappear.
   Restore sharing, then revoke Bob's access.
   His next call fails.

The example uses `limit=1` to expose empty filtered pages.
To exercise cross-notebook reads, repeat the setup in another notebook in the same project.
Keep the same tag in both notebooks.
Each app can read permitted history from both sources but can trigger only its own notebook's jobs.
