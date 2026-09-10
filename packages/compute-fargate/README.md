# @marimo-hub/compute-fargate

Compute adapter that runs each kernel sandbox as an AWS ECS Fargate task. It
connects to a standalone agent through the private task ENI.

Part of [marimohub](../../README.md). See [docs/compute.md](../../docs/compute.md)
for configuration and [examples/aws-fargate](../../examples/aws-fargate) for AWS resources.

Run `pnpm --filter @marimo-hub/compute-fargate test:agent` to test the Python
control agent. It requires Python 3.9 or later and uses only the standard library.
CI runs this suite alongside the TypeScript adapter tests.
