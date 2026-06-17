# Deploying

MarimoHub ships as a single container image (`apps/server/Dockerfile`) that
serves both the API and the web UI. Pick a platform below; each guide covers the
image, configuration, the three backends (storage / compute / auth), and
background maintenance.

- [Helm](./helm.md) — install/upgrade any cluster from the published, versioned
  `marimohub` chart (single-tenant).
- [CoreWeave (CKS)](./cks.md) — the reference production target (CAIOS + CoreWeave
  Sandboxes + OIDC).
- [Kubernetes](./kubernetes.md) — any cluster (EKS/GKE/AKS/self-managed) with native
  Pod kernels via the `kubernetes` compute backend.
- [GCP](./gcp.md) — GKE or Cloud Run + GCS.
- [AWS](./aws.md) — EKS or ECS/Fargate + native S3.
- [Cloudflare](./cloudflare.md) — Workers + R2 + Containers + Access (serverless).

See [Configuration](../configuration.md) for every variable.
