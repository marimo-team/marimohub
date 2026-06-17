<!-- Setup snippet — included by docs/storage.md and rendered in the deployment wizard. -->

Native Google Cloud Storage over its JSON API.

1. **Create a bucket** in your GCP project.
2. **Create a service account** and grant it object read/write on the bucket
   (`roles/storage.objectAdmin`, or `objectUser`).
3. **Download a JSON key** for that service account.
4. **Set the env** (pass the key's JSON contents):

```bash
MARIMOHUB_STORAGE_BACKEND=gcs
MARIMOHUB_STORAGE_GCS_BUCKET=orgname-marimohub
MARIMOHUB_STORAGE_GCS_SA_KEY='{ "type": "service_account", … }'  # key JSON (secret)
# …or, instead of a key, a pre-minted token:
# MARIMOHUB_STORAGE_GCS_ACCESS_TOKEN=ya29.…                      # (secret)
```

The key is minted into short-lived access tokens at runtime — no token rotation
to manage. See [Deploying → GCP](/deploying/gcp) for an end-to-end recipe.

::: tip Use this, not the S3 shim, on GCP
The native GCS backend gets safe concurrent writes via object **generations**.
GCS's S3-compatible endpoint has weak conditional-write support, so prefer `gcs`
over pointing the `s3` backend at GCS.
:::
