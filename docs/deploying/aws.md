---
description: Deploy marimohub using AWS compute, S3 storage, identity, and networking services.
---

# Deploying on AWS

Run the `apps/server` image on EKS or ECS/Fargate, backed by native S3 and a
compute backend (Modal today; no AWS-native compute adapter yet).

> Outline — not yet a tested recipe. Contributions welcome.

## Image

Build `apps/server/Dockerfile`, push to ECR, run on **EKS** (a Deployment, like
[CKS](./cks.md)) or **ECS/Fargate** (a stateless service). Listens on `:3000`.

## Storage — native S3

S3 is the native, best-supported backend. Prefer IAM roles over static keys: if
you omit the access keys, the AWS SDK default credential chain (IRSA on EKS, task
role on ECS) is used automatically.

```bash
MARIMOHUB_STORAGE_BACKEND=s3
MARIMOHUB_STORAGE_S3_BUCKET=orgname-marimohub
MARIMOHUB_STORAGE_S3_REGION=us-east-1
# No keys needed when an IAM role is attached (IRSA / task role).
```

## Compute

```bash
MARIMOHUB_COMPUTE_BACKEND=modal   # + Modal token/image (see Compute)
```

## Config & secrets

Store `MARIMOHUB_*` in SSM Parameter Store or Secrets Manager and inject as env.
Run maintenance as a separate one-replica service with
`MARIMOHUB_RUN_MAINTENANCE=true`. Front it with an ALB (target port 3000) and
terminate TLS with ACM.

## Validate

1. Check the ALB target health and `/api/health`.
2. Confirm the task or pod uses the intended IAM role.
3. Create and save a notebook.
4. Restart the app task or pod.
5. Confirm the notebook still exists in S3-backed storage.

## Production cautions

- Prefer IRSA or an ECS task role over static access keys.
- Run maintenance as exactly one replica.
- Choose and configure a production auth backend before exposing the ALB.

## Troubleshooting

See [Troubleshooting](../troubleshooting.md), especially startup failures,
storage preflight failures, and kernel startup failures.

## See also

[Storage](../storage.md) · [Compute](../compute.md) · [Auth](../auth.md) ·
[Configuration](../configuration.md)
