---
description: Deploy marimohub using Google Cloud compute, storage, identity, and networking services.
---

# Deploying on GCP

Run the `apps/server` image on GKE or Cloud Run, backed by Google Cloud Storage
(native `gcs` backend) and a compute backend — `kubernetes` (native Pods on GKE),
`modal`, or `e2b`.

> Outline — not yet a tested recipe. Contributions welcome.

## Image

Build `apps/server/Dockerfile`, push to Artifact Registry, run on **GKE** (a
Deployment, like [CKS](./cks.md)) or **Cloud Run** (one stateless service).
Listens on `:3000`.

## Storage — native GCS

Use the native `gcs` backend. It speaks the GCS JSON API and uses object
**generations** for the atomic conditional writes marimohub requires (no HMAC
keys, no S3 shim). Authenticate with a service-account key:

```bash
MARIMOHUB_STORAGE_BACKEND=gcs
MARIMOHUB_STORAGE_GCS_BUCKET=orgname-marimohub
MARIMOHUB_STORAGE_GCS_SA_KEY='{ "type": "service_account", … }'  # key JSON (secret)
```

Grant the service account `roles/storage.objectAdmin` on the bucket. On GKE you
can mount the key via Workload Identity → a Secret; the key is minted into
short-lived access tokens at runtime. (The legacy S3-shim path — `s3` backend
against `storage.googleapis.com` with HMAC keys — still works but has weaker
conditional-write guarantees; prefer the native backend.) See
[Storage → Google Cloud Storage](../storage.md#google-cloud-storage).

## Compute

On GKE, run kernels as native Pods in your cluster with the `kubernetes` backend
(see [Compute → Kubernetes](../compute.md#kubernetes)); otherwise use a managed
backend like `modal` or `e2b`.

```bash
MARIMOHUB_COMPUTE_BACKEND=kubernetes   # native Pods on GKE (or: modal / e2b)
```

## Config & secrets

Store `MARIMOHUB_*` in Secret Manager (or a k8s Secret on GKE) and inject as env.
On GKE, run maintenance separately with `MARIMOHUB_RUN_MAINTENANCE=true`. On
Cloud Run, drive maintenance from a **Cloud Scheduler** job instead of an
always-on replica.

## Validate

1. Check service health and `/api/health`.
2. Confirm the service account can read and write objects in the GCS bucket.
3. Create and save a notebook.
4. Restart the app service.
5. Confirm the notebook still exists in GCS-backed storage.

## Production cautions

- Prefer the native `gcs` backend over the S3 shim.
- Store service-account material in Secret Manager or a Kubernetes Secret.
- Run maintenance once. On Cloud Run, trigger it with Cloud Scheduler.
- Configure production auth before exposing the service.

## Troubleshooting

See [Troubleshooting](../troubleshooting.md), especially storage preflight and
kernel startup failures.

## See also

[Storage](../storage.md) · [Compute](../compute.md) · [Auth](../auth.md) ·
[Configuration](../configuration.md)
