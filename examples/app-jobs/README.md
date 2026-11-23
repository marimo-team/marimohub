# Shared app job history

Import [app.py](app.py) into a hosted notebook with proxy exposure and jobs enabled.
The hosted runtime supplies `marimohub.jobs`; this example requires an admitted
visitor and cannot call jobs from a standalone local marimo server.

1. Create a job in this notebook with `consumer_execution=true` and
   `consumer_history="shared"`. Also create a job with consumer execution enabled
   and `consumer_history="private"`.
2. Add Alice and Bob as project app-users. Open the published app in separate
   signed-in browser sessions. Each visitor's `Jobs()` stays inside their session.
3. Enter the shared job ID and submit as Alice. Wait for success. As Bob, click
   **Refresh history and my active runs** and page through the shared result.
4. Edit and save the notebook (for example, change the Submit button label), then
   reopen the published app. Keep the tag `app=shared-history-demo-v1` unchanged.
   Submit as Bob. Both consumers can page through completed runs with the two
   distinct `source_version_id` values.
5. Enter the private job ID and submit as Alice. Bob cannot see this run even
   though it uses the same tag. Alice can see her own private run.
6. While runs are queued or running, refresh both sessions. **My active runs**
   filters to the signed-in visitor across versions. Each Next button fetches
   exactly one page; a filtered-out entry produces an empty page with Next still
   enabled. Continue until Next is disabled.
7. Disable sharing on the shared job and refresh Bob's view: Alice's runs
   disappear. Restore sharing and revoke Bob's access: his next call fails.

The example uses limit=1 so empty filtered pages are easy to reproduce.
Completed shared parameters are visible to authorized consumers; do not submit
secrets as parameters. To also exercise cross-notebook reads, import the example
into a second notebook in the same project, create a shared job there, and submit
with the same immutable tag. Each app can read both sources' permitted history
but can trigger only jobs in its own notebook.
