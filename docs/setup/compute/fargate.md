<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

Fargate runs one on-demand ECS task for each notebook sandbox in your AWS
account and VPC. The hub connects to the private task ENI. The browser connects
through the authenticated hub proxy.

Before you configure the hub:

1. Copy `packages/compute-fargate/agent/fargate_agent.py` into your notebook
   image. Make the file executable. The agent needs Python 3 and no third-party
   Python packages.
2. Register a Linux `awsvpc` task definition with `FARGATE` compatibility.
   Configure a non-root user. Configure `/workspace` as a writable directory.
   Expose ports 2717 and 2718. If you enable VS Code, expose port 8443 by
   default. If you enable OpenCode, expose port 4096 by default. Set
   `taskRoleArn` to the IAM role for notebook AWS access. Do not put static AWS
   access keys in the image or task definition. See the
   [example task definition](../../../examples/aws-fargate/kernel-task-definition.json).
3. Put the hub and notebook tasks in private subnets. Allow the hub security
   group to reach ports 2717 and 2718 on the notebook security group. If you
   enable VS Code, allow its configured port. If you enable OpenCode, allow its
   configured port.
4. Give the hub the required ECS permissions. Permit `iam:PassRole` only for
   the execution role and task role. See the [example policy](../../../examples/aws-fargate/hub-iam-policy.json).
5. Set these environment variables on the hub:

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

The task definition pins the notebook image. A new task-definition revision
changes the image. Do not set `MARIMOHUB_COMPUTE_IMAGE` for this backend.

`MARIMOHUB_COMPUTE_FARGATE_CONTAINER_NAME` defaults to `marimo`. The agent port
defaults to 2717. The ready timeout defaults to 120 seconds. Public IP assignment
defaults to `false`.

The owner value must be unique for each independent hub deployment in an AWS
account. The adapter uses this value to find and stop its tasks.

The adapter uses the hub runtime's AWS identity to call ECS. It does not have a
Fargate-specific static credential setting. When the hub runs outside an
AWS-managed runtime, set `AWS_REGION`.

Fargate maps CPU and memory profiles to valid billed pairs. It does not support
GPU profiles, Spot capacity, public subdomains, EFS, or ECS Exec.
