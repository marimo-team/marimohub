# Project run history

## API

All paths start with `/api/v1/projects/{pid}`.

- Submit a run: `POST /notebooks/{nid}/jobs/{jid}/runs`.
- List project runs: `GET /runs`.
- List job runs: `GET /notebooks/{nid}/jobs/{jid}/runs`.

Both lists accept these optional filters:

| Filter                    | Match                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| `status`                  | One exact status, or `active` for queued, provisioning, and running |
| `triggered_by`            | An exact user ID                                                    |
| `tag_key` and `tag_value` | One exact, case-sensitive submission tag (project list only)        |

Use `triggered_by_me=true` to select the authenticated user.
Do not combine `triggered_by_me` with `triggered_by`.
The value `triggered_by=me` selects the literal user ID `me`.

Supply both tag fields or neither. All supplied filters must match.
To reconnect to your active submissions across app versions, use:

```http
GET /runs?tag_key=app&tag_value=calibration-runner&status=active&triggered_by_me=true
```

## Submission tags

Submit immutable tags in the manual run request:

```json
{ "tags": { "app": "calibration-runner", "app_version": "v3" } }
```

Use the same `app` value across releases and a distinct value for each app.
Tags are conventions, not proof of identity or ownership. Authorized callers can reuse tags across notebooks.
Publishing and copying notebooks do not assign tags.

Tags have at most 32 entries and occupy at most 8,192 UTF-8 bytes as JSON.
Keys start with an ASCII letter and contain up to 64 letters, digits, dots, underscores, or hyphens.
Values contain at most 256 characters.
Automatic retries inherit the accepted tags. Scheduled runs without submitted tags remain untagged.

To diagnose missing tags, inspect the trigger response or list runs without a tag filter.

## Pagination and access

Project lists and filtered job lists scan at most `limit` index entries per request, capped at 500.
Results can contain fewer entries, including none.
Continue with `next_cursor` until it is null, even when `items` is empty.
Unfiltered job lists retain their existing cursor format and page behavior.

Runs sort by descending run ID; the random part of the ULID breaks timestamp ties.
A retry's ID is minted with the attempt it retries, so the retry sorts at that attempt's
enqueue time. An active retry can therefore appear after newer runs. To find every active
run, scan until `next_cursor` is null.
New submissions do not shift an existing page boundary.

Filtered cursors bind to the resource and resolved query, including the resolved user ID for `triggered_by_me`.
Project cursors also bind to the tag filter.
If the resource, filter, or user for `triggered_by_me` changes, restart from the first page.

Each page reads current run status. Pagination is not a snapshot.
Runs can finish between pages, and later pages do not revisit earlier entries.
Restart from the first page to refresh the active set.

Every result requires current project and source job access, including notebook security labels and history-sharing permissions.
Filters never grant access. Deleted or inaccessible jobs produce no results.

## Index and repair

`JobRunService` owns immutable locators at `projects/{pid}/run-index/{reverse_ulid}.json`.
Locators contain notebook, job, and run IDs. Run records remain authoritative for tags and status.
A project listing reads one index page and at most two objects per entry, plus bounded authorization reads.
Missing records do not remove the continuation cursor.

Enqueue stores the recovery marker and run before creating the project locator.
Locator creation is idempotent and preserves accepted tags.
If indexing fails, the accepted run remains valid but can be absent from project history.
Finalization repairs the locator before it audits the run, sends alerts, or removes the marker.
A failed repair retains the marker, so the next scheduler tick retries it before any alert is sent.

The `project-run-index-v1` migration scans at most 500 project objects per batch.
`MigrationService` checkpoints progress and retries failed batches. `JobRunService` writes the index.
The migration skips a run record that does not parse or whose IDs do not match its key, and logs
`stored_object_skipped`. Storage errors still fail the batch for retry.
Backfill neither infers tags nor rewrites runs.

A project listing skips a corrupt locator, a locator whose run ID does not match its key, and a run
record whose IDs do not match its locator. Each skip logs `stored_object_skipped`.

Locators share their file name with the per-job history entry, so moves and deletions derive
them from that index without reading run records. A move writes destination locators after
copying the job history and deletes the source locators when it finishes. Job deletion and
the notebook purge delete the locators before they remove the per-job index, so a failed
attempt retries with the same keys.

Retention removes the project locator with the run. Bounded pruning retries locator cleanup
when a previous attempt removed the run but failed to remove its indexes.
A delayed publication that lands after deletion leaves a stale locator until the project is deleted.
A delayed locator cannot expose a missing run.

Manual-run admission counts queued runs from the project's active markers at
`_system/job-runs/{pid}/`, not from every marker in the deployment.
