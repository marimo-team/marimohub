---
description: Configure the private AWS ECS Fargate compute backend.
---

# AWS ECS Fargate

The Fargate backend starts one on-demand ECS task for each notebook sandbox.
The task definition is created and revised by the operator before the hub
starts. Marimohub does not register task definitions and does not accept an
arbitrary notebook image.

Use a private network path from the hub service to the task ENI. v1 supports
`MARIMOHUB_SANDBOX_EXPOSURE=proxy` only. The browser reaches the kernel through
the hub's authenticated proxy, not through a public task address.

## Required setup

1. Build the official sandbox image or an image that contains the agent at
   `/usr/local/lib/marimohub/fargate_agent.py`.
2. Register a Linux `awsvpc` task definition with the `FARGATE` compatibility,
   a non-root agent container, writable `/workspace`, ports 2717 and 2718, and
   an ECS logs configuration. See the [example task definition](../../../examples/aws-fargate/kernel-task-definition.json).
3. Put the hub task and notebook tasks in private subnets. Allow TCP 2717 and
   2718 from the hub security group to the task security group. Provide NAT or
   VPC endpoints for ECR, CloudWatch Logs, and any package registries used by
   notebook setup.
4. Attach the least-privilege hub policy and pass only the task execution and
   task roles to ECS. See the [example policy](../../../examples/aws-fargate/hub-iam-policy.json).

Set these variables on the hub:

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

`MARIMOHUB_COMPUTE_FARGATE_CONTAINER_NAME` defaults to `marimo`.
`MARIMOHUB_COMPUTE_FARGATE_AGENT_PORT` defaults to 2717, and the readiness
timeout defaults to 120 seconds. `MARIMOHUB_COMPUTE_FARGATE_ASSIGN_PUBLIC_IP`
defaults to `false`; keep it false for private deployments. The configured
owner is included in `startedBy` and tags, so use a different value for each
independent hub deployment sharing an AWS account.

The adapter uses the standard AWS SDK for JavaScript region and credential
providers. Set `AWS_REGION` explicitly when the hub runs outside an
AWS-managed runtime. Credentials may come from `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN`, the shared AWS config and
credentials files (with `AWS_PROFILE`), or the role provider supplied by the
runtime. Do not add a second Fargate-specific credential configuration.

Do not set `MARIMOHUB_COMPUTE_IMAGE` for this backend. Compute profiles map to
valid Fargate CPU/memory pairs and round up to the next billable allocation;
GPU profiles are unsupported and are rejected before launch.

## Security and operations

The hub derives an HMAC token from the master secret and the sandbox id. Only
the derived token is sent as a task override. The agent compares it in constant
time, removes it from child environments, limits request and output sizes, and
kills complete process groups on timeout. The task role can read credentials
injected for the notebook, so apply the same credential policy as any other
kernel runtime.

Task discovery is scoped by the owner and exact sandbox-id tag. A duplicate
live task is an error rather than a reason to stop an arbitrary task. Stopping
is idempotent. Change the task-definition revision to roll the kernel image;
reconnect uses the revision recorded on the running task.

The adapter does not use ECS Exec, public subdomains, per-task load balancers,
Spot capacity, EFS, or runtime task-definition registration.

The opt-in live harness validates task launch, agent operations, reconnect,
enumeration, and teardown. It does not validate the full hub HTTP/WebSocket
proxy route; test that route from the deployed hub network before accepting a
deployment. See the AWS deployment guide for the exact opt-in command and
environment variables. This harness is not a claim of production verification.
