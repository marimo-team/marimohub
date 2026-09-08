# AWS ECS Fargate compute

`@marimo-hub/compute-fargate` runs one pre-registered Fargate task per
notebook sandbox. The task definition owns the image and starts the bundled
authenticated agent as its main process. The hub reaches the agent over the
task's private ENI; browser traffic remains on the existing authenticated
proxy surface.

The adapter accepts one logical image key (`default`) in v1. It never registers
task-definition revisions and never sends a notebook image to ECS. Operators
change the task-definition revision to roll the image.

| Sandbox operation                     | Agent route / implementation                         |
| ------------------------------------- | ---------------------------------------------------- |
| `ready`, reconnect, destroy           | ECS `DescribeTasks`, `RunTask`, `StopTask`           |
| `exec`, `execStream`                  | `POST /exec` (buffered, bounded output)              |
| `readFile`, `writeFiles`              | `GET /files/read`, `POST /files/write` (base64)      |
| `listFiles`, `gitCheckout`            | bounded `exec` using compute-commons helpers         |
| `setEnvVars`                          | `POST /env` persistent forced/default overlays       |
| `startProcess`, logs, kill, readiness | `/processes` routes and process groups               |
| `exposePort`                          | private `http://<task-eni-ip>:<port>` origin         |
| bucket mount                          | unsupported; the provisioner uses file-copy fallback |

All agent requests carry an HMAC-derived per-sandbox bearer token. The master
secret stays in the hub, and the agent removes its request token from child
process environments. Keep the task and hub in private subnets and permit
agent/kernel ports only from the hub security group.
