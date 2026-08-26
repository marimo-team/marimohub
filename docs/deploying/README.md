---
description: Choose a deployment guide for Helm, Kubernetes, cloud platforms, or a single instance.
---

# Deploying

marimohub ships as a single container image (`apps/server/Dockerfile`) that
serves both the API and the web UI. Pick a platform below; each guide covers the
image, configuration, the three backends (storage / compute / auth), and
background maintenance.

- [Helm](./helm.md) — install/upgrade any cluster from the published, versioned
  `marimohub` chart (single-tenant).
- [Single instance](./single-instance.md) — one Linux box (cloud VM or on-prem)
  with `fs` storage + `docker` compute; no object store, no cluster.
- [CoreWeave (CKS)](./cks.md) — CAIOS + CoreWeave Sandboxes + OIDC.
- [Kubernetes](./kubernetes.md) — any cluster (EKS/GKE/AKS/self-managed) with native
  Pod kernels via the `kubernetes` compute backend.
- [GCP](./gcp.md) — GKE or Cloud Run + GCS.
- [AWS](./aws.md) — EKS or ECS/Fargate + native S3.
- [Cloudflare](./cloudflare.md) — Workers + R2 + Containers + Access (serverless).

## Path prefix

To publish the Node deployment at `https://hub.example.com/marimohub/`, set:

```bash
MARIMOHUB_APP_BASE_URL=https://hub.example.com/marimohub
MARIMOHUB_AUTH_OIDC_REDIRECT_URI=https://hub.example.com/marimohub/api/auth/callback
```

Configure nginx to strip the prefix and forward WebSocket connections:

```nginx
location /marimohub/ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://marimohub:3000/;
}
```

The trailing slash on `proxy_pass` strips the prefix. `X-Forwarded-Proto`
preserves HTTPS in public links. The path prefix is runtime configuration, so one
image can serve different prefixes.

After deploy, validate the same core flow on every platform:

1. Check `/api/health`.
2. Sign in through the configured auth backend.
3. Create a project and notebook.
4. Start a kernel.
5. Save the notebook and confirm it survives a server restart.

See [Configuration](../configuration.md) for every variable and
[Troubleshooting](../troubleshooting.md) for common startup, login, and kernel
failures.
