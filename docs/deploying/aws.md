---
description: Deploy marimohub using AWS compute, S3 storage, identity, and networking services.
---

# Deploying on AWS

Run the `apps/server` image on EKS or ECS/Fargate, backed by native S3. ECS
deployments can run kernels with the AWS-native Fargate adapter.

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
MARIMOHUB_COMPUTE_BACKEND=fargate
MARIMOHUB_SANDBOX_EXPOSURE=proxy
MARIMOHUB_COMPUTE_FARGATE_CLUSTER=marimohub
MARIMOHUB_COMPUTE_FARGATE_TASK_DEFINITION=marimohub-kernel:1
MARIMOHUB_COMPUTE_FARGATE_SUBNETS=subnet-aaa,subnet-bbb
MARIMOHUB_COMPUTE_FARGATE_SECURITY_GROUPS=sg-kernels
MARIMOHUB_COMPUTE_FARGATE_OWNER=prod-hub-a
MARIMOHUB_COMPUTE_FARGATE_AGENT_SECRET='<at least 32 random bytes>'
```

Register the task definition first; it must run the bundled control agent as a
non-root process with writable `/workspace` and ports 2717/2718. Keep hub and
kernel tasks in private subnets and allow those ports only from the hub security
group. The task execution role needs ECR and CloudWatch Logs access. The hub
needs scoped ECS RunTask/Describe/List/Stop permissions and PassRole only for
the two kernel roles. See [the example task definition](../../examples/aws-fargate/kernel-task-definition.json),
[hub policy](../../examples/aws-fargate/hub-iam-policy.json), and [Fargate setup](../compute.md#aws-ecs-fargate).

Fargate CPU/memory profiles round up to the next official Fargate allocation,
so billing follows the selected pair. GPU and Spot capacity are not supported.
There is no public kernel hostname or per-task load balancer. The hub stops
owned tasks during teardown; periodically review stopped tasks and CloudWatch
logs when retiring a task-definition revision.

The ECS adapter uses the standard AWS SDK region and credential chain. Set
`AWS_REGION` explicitly outside an AWS-managed runtime. It accepts standard
environment credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
optional `AWS_SESSION_TOKEN`), shared config/credentials files with
`AWS_PROFILE`, or the runtime's task-role/workload-identity provider.

The opt-in `MARIMOHUB_FARGATE_LIVE_TEST=1` harness validates the ECS task,
agent operations, reconnect, enumeration, and teardown. It does not validate
the full hub HTTP/WebSocket proxy route. Treat proxy routing from the deployed
hub network as a separate acceptance check; the harness does not establish
production verification.

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
