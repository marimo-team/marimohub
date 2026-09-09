# AWS ECS Fargate example

This directory contains an ECS task definition and a scoped IAM policy for the
Fargate compute adapter.

## Container image

Copy the standalone agent into any notebook image:

```dockerfile
FROM your-notebook-image

COPY --chmod=0755 packages/compute-fargate/agent/fargate_agent.py /usr/local/bin/marimohub-fargate-agent
```

If you build outside the repository root, put `fargate_agent.py` next to your
Dockerfile. The image needs Python 3, `sh`, marimo, uv, and git. The agent uses
only the Python standard library.

## AWS resources

Replace the image, region, and role ARNs in `kernel-task-definition.json`.
Then register the task definition:

```sh
aws ecs register-task-definition \
  --cli-input-json file://kernel-task-definition.json
```

The execution role pulls the image and writes logs. The task role gives AWS
credentials to the notebook through the ECS task metadata endpoint. Do not put
static AWS access keys in the image or task definition.

The hub security group must reach task ports 2717 and 2718. Keep the notebook
tasks in private subnets. See the [Fargate setup guide](../../docs/setup/compute/fargate.md)
for the IAM policy, network, and hub configuration.

## Live acceptance

After you export the required Fargate variables, run the live acceptance test:

```bash
MARIMOHUB_FARGATE_LIVE_TEST=1 pnpm --filter @marimo-hub/compute-fargate test -- fargate.live.test.ts
```

This test covers task launch, agent operations, reconnect, discovery, and task
stop. It does not cover the hub HTTP or WebSocket proxy.
