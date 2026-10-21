# Object uploads in the data browser

Managers can upload files to S3, GCS, and Azure Blob integrations from the data browser.
Enable the data browser and set `allow_write: true` in the integration configuration.
This setting defaults to `false`. The integration's credentials must also permit writes to the selected bucket or container.

Uploads require both `integration.use` and `integration.write`. The latter requires a project manager by default.
The Upload button appears only when the integration and the current user have write access.
Ambient server credentials remain read-only, even when ambient reads are enabled.
WIF credentials allow uploads only when their broker explicitly attests write scope;
brokers that do not provide that attestation remain read-only.

Select a bucket or container, open the target prefix, and click **Upload**.
Files use their local names under that prefix. An existing object at that key is replaced.
The provider's versioning and retention rules still apply.
After publication, the browser refreshes the object listing.
Each successful publication emits an `integration.object.put` audit event with the actor, integration, bucket, key, and byte count.

The browser sends 8 MiB parts through the hub, with progress for each file.
Uploads can be up to 5 GiB. A project permits up to 16 unfinished object uploads,
with at most 5 GiB of declared data across them.
To resume after a reload or connection failure, select the same file in the same browser tab.
The browser verifies its contents before reusing stored parts. Uploads expire after 24 hours.
Changing the integration configuration invalidates existing uploads; start a new upload with the new configuration.

Publication streams staged parts to the provider. Workspace size limits do not apply to customer objects.
If publication stops before its receipt is saved, the API returns `409` on retry.
Check the destination before starting a new upload, because the first publication might have succeeded.

The API routes start at
`/api/v1/projects/{pid}/integrations/{iid}/browse/objects/uploads`.
Use `POST` to start, `GET /{id}` to inspect progress, `PUT /{id}/parts/{part}` to send parts,
`POST /{id}/complete` to publish, and `DELETE /{id}` to cancel.
Authorization, ownership, and integration state are checked for each request.
See the [API reference](./api.md) and [workspace upload documentation](./editor-sessions.md#resumable-uploads).
