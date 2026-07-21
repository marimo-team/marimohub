# Deploying

marimohub ships as a single container image (`apps/server/Dockerfile`) that
serves both the API and the web UI. Pick a platform below; each guide covers the
image, configuration, the three backends (storage / compute / auth), and
background maintenance.

- [Helm](./helm.md) — install/upgrade any cluster from the published, versioned
  `marimohub` chart (single-tenant).
- [CoreWeave (CKS)](./cks.md) — CAIOS + CoreWeave Sandboxes + OIDC.
- [Kubernetes](./kubernetes.md) — any cluster (EKS/GKE/AKS/self-managed) with native
  Pod kernels via the `kubernetes` compute backend.
- [GCP](./gcp.md) — GKE or Cloud Run + GCS.
- [AWS](./aws.md) — EKS or ECS/Fargate + native S3.
- [Cloudflare](./cloudflare.md) — Workers + R2 + Containers + Access (serverless).

After deploy, validate the same core flow on every platform:

1. Check `/api/health`.
2. Sign in through the configured auth backend.
3. Create a project and notebook.
4. Start a kernel.
5. Save the notebook and confirm it survives a server restart.

See [Configuration](../configuration.md) for every variable and
[Troubleshooting](../troubleshooting.md) for common startup, login, and kernel
failures.
