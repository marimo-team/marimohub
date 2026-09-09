# AWS ECS Fargate example

This directory contains a starting point for a private Fargate kernel task.
Replace the image and role ARNs, register the task definition, and grant the
hub the scoped policy before selecting `backend=fargate`.

Copy the single Fargate agent into your own image. The image does not need to
inherit from the marimohub sandbox image:

```dockerfile
FROM your-notebook-image

COPY --chmod=0755 packages/compute-fargate/agent/fargate_agent.py /usr/local/bin/marimohub-fargate-agent
```

Run the Docker build from the repository root, or copy `fargate_agent.py` next
to your own Dockerfile and adjust the `COPY` source. The runtime image needs
Python 3, `sh`, marimo, uv, and git. The agent itself uses only the Python
standard library. Set the task definition's `user` to the non-root uid used by
your image.

The hub must be able to route to task ENIs in the selected subnets. Permit the
hub security group to reach TCP 2717 (agent) and 2718 (marimo) on the task
security group. Keep public IP assignment disabled unless a deliberate network
review approves it; the browser still uses the hub proxy.

The task role is intentionally separate from the execution role. The execution
role pulls the image and writes logs. The task role is where notebook-specific
AWS access would be granted, so keep it empty by default and add only the
minimum data permissions needed by the deployment.

```sh
aws ecs register-task-definition \
  --cli-input-json file://kernel-task-definition.json
```

See [the Fargate setup guide](../../docs/setup/compute/fargate.md) for network,
secret, profile, cleanup, and proxy configuration.
