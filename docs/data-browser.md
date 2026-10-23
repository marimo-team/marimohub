# Object uploads in the data browser

The data browser supports uploads to S3, GCS, and Azure Blob integrations.
Use `MARIMOHUB_DATA_BROWSER=metadata` (the default) or `full`.
Set `allow_write: true` in the integration configuration (default: `false`).
The integration credentials must permit writes to the destination.

Uploads require `integration.use` and `integration.write` (project manager by default).
Ambient server credentials are read-only. WIF credentials require explicit write scope from their broker.
The built-in AWS and CoreWeave brokers do not attest write scope, so federated S3 uploads remain disabled.
The **Upload** button appears only with write access.

Select a bucket or container, open the target prefix, then click **Upload**.
Each file keeps its local name and replaces any object at that key.
Provider versioning and retention rules still apply.
Successful uploads refresh the listing and emit an `integration.object.put` audit event with the actor, integration, bucket, key, and byte count.

Each project permits 16 unfinished object uploads, with at most 5 GiB of declared data across them.
Workspace limits do not apply. Uploads use 8 MiB parts and expire after 24 hours.
After a reload or connection failure, select the same file in the same tab to resume.
The browser checks its contents before it reuses parts.
If the integration configuration changes, unfinished uploads return `409` and cannot resume.
Check the destination before you retry, because an earlier publication can succeed even if its response is lost.
Click **Restart** next to the failed file and confirm to discard its saved progress and start a new upload.
The browser attempts to cancel the old upload first. An uncertain publication keeps its server receipt for cleanup.

If completion returns `409` for an interrupted publication, check the destination before you start another upload.
The original write can succeed even if its response is lost.

API operations use `/api/v1/projects/{pid}/integrations/{iid}/browse/objects/uploads`:

| Operation        | Method and suffix        |
| ---------------- | ------------------------ |
| Start            | `POST`                   |
| Progress         | `GET /{id}`              |
| Part (one-based) | `PUT /{id}/parts/{part}` |
| Complete         | `POST /{id}/complete`    |
| Cancel           | `DELETE /{id}`           |

Each request checks authorization and ownership.
Unfinished uploads require the original integration revision, except for cancellation.
Completed uploads return their saved result without another write, even after an integration configuration change.
See the [API reference](./api.md) for request and response schemas.
