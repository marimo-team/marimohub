# Project run history

Submit immutable tags with a manual run:

```json
{ "tags": { "app": "calibration-runner", "app_version": "v3" } }
```

Use the same `app` value across releases and a different value for a distinct app.
Tags are application conventions. They do not establish identity, ownership, or access.
Authorized callers can reuse a tag, including on unrelated notebooks.
Publishing and copying notebooks do not assign or infer tags.

## API

All paths start with `/api/v1/projects/{pid}`.

- Trigger: `POST /notebooks/{nid}/jobs/{jid}/runs` with optional `tags`.
- List: `GET /runs?tag_key=app&tag_value=calibration-runner`.
- Diagnose missing tags: inspect the trigger response, then use authorized `GET /runs` without a filter.

The list accepts one exact, case-sensitive key/value predicate. Supply both filter fields or neither.
Tags have at most 32 entries. Keys start with an ASCII letter and contain up to 64 letters, digits, dots, underscores, or hyphens.
Values contain at most 256 characters. Serialized tags must fit in 8,192 UTF-8 bytes.
Tags cannot change after submission. Automatic retries inherit the accepted tags.
Scheduled runs without submitted tags remain untagged.

Responses use the existing run shape, including source attribution, status, timestamps, triggerer, and tags.
Run metadata and run-scoped credentials belong to MO-8718; this API does not define their contract.
Reports, files, and metrics remain external. A reference does not grant access to an external service.
Existing job-scoped history and run lookups remain available.

## Pagination and access

`limit` bounds scanned index entries, with a maximum of 500. Results can contain fewer entries.
Always follow `next_cursor` until it is null, even when `items` is empty.
Cursors bind to the project and exact filter. Changing the filter requires restarting the scan.
Ordering follows descending run IDs: their ULID timestamp provides newest-first order, with the remaining ID providing a deterministic tie-breaker.
Newer submissions do not shift an existing page boundary.

Every read uses current project and source job permissions, including source notebook security labels.
Tags never bypass these checks. Existing reader permissions remain unchanged; consumer execution and sharing policies are separate work.
Deleted or inaccessible jobs contribute no results. This iteration does not grant access through archived source records.
Source-deletion survival and retention policy changes belong to MO-8720; additional status/user filters belong to MO-8721.

## Index and repair

`JobRunService` owns immutable locators at `projects/{pid}/run-index/{reverse_ulid}.json`.
Locators contain notebook, job, and run IDs. Run records remain authoritative for tags and status.
One listing reads at most one index page and two objects per scanned entry, plus bounded live authorization reads.
No request scans every notebook history. Missing records are skipped without losing the continuation.

Enqueue writes the recovery marker and canonical run before publishing the project locator.
Publication is create-if-absent, so concurrent retries converge on one entry and preserve accepted tags.
If indexing fails after acceptance, the trigger still returns the accepted run. History can lag until marker repair succeeds.
Finalization repairs the locator before removing the marker. A failed repair retains the marker for retry.
The `project-run-index-v1` background migration scans at most 500 project objects per batch and indexes canonical run records.
MigrationService checkpoints progress and retries failed batches; JobRunService owns the index writes. Builders do not call a repair endpoint.
Operators can inspect migration progress through the existing migration tooling.
Backfill never infers tags or rewrites runs; untagged history stays available in unfiltered and job-scoped reads.
Finite retention removes the project locator alongside the run. A delayed locator or a locator left by source deletion cannot expose a missing run.
