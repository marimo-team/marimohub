---
description: Choose AWS compute, storage, and auth, then add private packages, managed AI, and security controls.
---

# Deploying on AWS

Use this page to choose AWS services for marimohub. The linked setup guides contain the deployment commands and required permissions.

## Compute

The hub serves the API and web UI. The compute backend runs notebook kernels. These can run on different services.

| Hub host                           | Notebook compute                             | Setup                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EKS                                | `kubernetes`: one Pod per notebook sandbox   | [Helm](./helm.md) and [Kubernetes](./kubernetes.md)                                                                                                       |
| ECS/Fargate or EKS with VPC access | `fargate`: one ECS task per notebook sandbox | [Fargate setup](../compute.md#aws-ecs-fargate) and [example resources](https://github.com/marimo-team/marimohub/blob/main/examples/aws-fargate/README.md) |
| EC2 Linux VM                       | `docker`: one container per notebook sandbox | [Single instance](./single-instance.md)                                                                                                                   |
| Any supported hub host             | External compute, such as `modal` or `e2b`   | [Compute backends](../compute.md)                                                                                                                         |

### Image

Run the published `ghcr.io/marimo-team/marimohub:<VERSION>` image, or build `apps/server/Dockerfile` and push it to ECR. The hub listens on port 3000.

Build a separate [sandbox image](../sandbox-image.md) for notebooks. Fargate requires the standalone agent and uses the image from its task definition. Kubernetes uses `MARIMOHUB_COMPUTE_IMAGE`.

Fargate supports private tasks with hub proxy exposure. It does not support GPU profiles, Spot capacity, EFS, or public sandbox subdomains. Use Kubernetes for GPU kernels.

## Storage

| Storage                                         | Backend | Constraints                                                    |
| ----------------------------------------------- | ------- | -------------------------------------------------------------- |
| S3 bucket                                       | `s3`    | Supports multiple hub processes with atomic conditional writes |
| EBS volume on EC2                               | `fs`    | One hub process with a persistent filesystem mount             |
| EBS-backed persistent volume claim (PVC) on EKS | `fs`    | Custom volume mount and one hub process, including maintenance |

A PVC stores the hub's catalog and notebook objects through `fs`. It does not configure persistent volumes for notebook kernels. A shared filesystem does not make `fs` safe for multiple hub processes.

### Storage — native S3

```bash
MARIMOHUB_STORAGE_BACKEND=s3
MARIMOHUB_STORAGE_S3_BUCKET=<bucket-name>
MARIMOHUB_STORAGE_S3_REGION=us-east-1
```

With access keys unset, the adapter uses the AWS SDK credential chain. Use an ECS task role, EKS workload identity, or an EC2 instance role.

See [S3 storage](../storage.md#s3-compatible-setup) for permissions and preflight checks. For filesystem storage, use the [single-instance configuration](./single-instance.md).

## Auth

Use the `oidc` backend with Amazon Cognito or your organization's OIDC provider.

Use the issuer from your Cognito user pool discovery document. A standard issuer has this form:

```bash
MARIMOHUB_AUTH_BACKEND=oidc
MARIMOHUB_AUTH_OIDC_ISSUER=https://cognito-idp.<region>.amazonaws.com/<user-pool-id>
MARIMOHUB_AUTH_OIDC_CLIENT_ID=<client-id>
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET='<client-secret>'
MARIMOHUB_AUTH_OIDC_REDIRECT_URI=https://hub.example.com/api/auth/callback
MARIMOHUB_AUTH_SESSION_SECRET='<at least 32 random bytes>'
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=example.com
```

Configure a user pool domain and a confidential app client with the authorization code flow. Register the exact callback URL. Store both secrets in your deployment's secret manager. See [OIDC setup](../auth.md#oidc-production) for email verification and group policies.

See [Cognito endpoints](https://docs.aws.amazon.com/cognito/latest/developerguide/federation-endpoints.html) for standard and updated issuer formats.

Browser login and AWS permissions are separate. The hub role controls storage and ECS access. The notebook role controls AWS calls from notebook code.

## Features

### Private Python packages with CodeArtifact

Use the [AWS CodeArtifact integration](../integrations.md#aws-codeartifact). The
hub mints a CodeArtifact token for each new session or job and injects it for
uv. No keyring helper, AWS CLI, or startup script is needed in the sandbox image.

Choose an authentication method:

- **Project AWS workload identity**: the hub exchanges the project's
  [AWS federation](../workload-identity-federation.md) credentials for a token.
  The project needs workload identity enabled with an AWS broker.
- **AWS credentials**: an access key for an IAM user. The keys stay on the hub;
  only the token reaches the sandbox.

Grant the role or user `codeartifact:GetAuthorizationToken`,
`sts:GetServiceBearerToken`, and `codeartifact:ReadFromRepository`. A token
carries all CodeArtifact permissions of its principal, including publish, so use
a read-only principal. See
[CodeArtifact permissions](https://docs.aws.amazon.com/codeartifact/latest/ug/auth-and-access-control-permissions-reference.html)
for domain and repository scopes.

Tokens last 12 hours. A session that runs longer must restart before it installs
more packages.

Do not also set `UV_INDEX` for CodeArtifact in the task definition or sandbox
image. The injected value replaces it. See
[private package indexes](../sandbox-image.md#private-package-indexes) for how
injected and custom index settings combine.

### Managed AI with Bedrock

Use the built-in Bedrock backend for notebook assistants:

```bash
MARIMOHUB_AI_BACKEND=bedrock
MARIMOHUB_AI_AWS_REGION=us-east-1
MARIMOHUB_AI_MODEL=<supported-model-or-inference-profile-id>
```

Grant the **hub role** `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` for the selected models. Configure `MARIMOHUB_AUTH_SESSION_SECRET` and an allowed model list. The hub signs requests and keeps its AWS credentials outside notebooks. See [Bedrock setup](../ai.md#amazon-bedrock).

### Data and secrets

- Add [S3](../integrations.md#s3), [Athena](../integrations.md#amazon-athena), [Redshift](../integrations.md#amazon-redshift), or [Glue catalog](../integrations.md#iceberg-aws-glue-catalog) integrations for notebook data.
- Use [AWS Secrets Manager references](../integration-secrets.md#aws-secrets-manager) for integration credentials.
- Use [federated cloud access](../workload-identity-federation.md#example-aws-s3-athena) for project-scoped AWS permissions, subject to its credential lifetime.

## Security

- Keep notebook tasks private. Permit agent and notebook ports only from the hub security group.
- Give hub and notebook identities separate permissions. Limit the hub's `iam:PassRole` permission to the required task and execution roles.
- Keep the deployment bucket private. Scope notebook data permissions separately from the hub's catalog permissions.
- Terminate HTTPS at your ingress or ALB. Configure WebSocket forwarding and timeouts for notebook sessions.
- For untrusted users, review [kernel exposure](../security.md#kernel-exposure). Fargate's same-origin proxy has different isolation properties from Kubernetes subdomains.

## Config & secrets

Inject deployment secrets from SSM Parameter Store or Secrets Manager. This deployment configuration is separate from the app's integration secret resolver.

## Operations

With S3, run one maintenance replica with `MARIMOHUB_RUN_MAINTENANCE=true`. Set it to `false` on API replicas. With `fs`, set `MARIMOHUB_RUN_MAINTENANCE=true` in the sole hub process. Do not start a separate maintenance process against the same filesystem.

Use [Operations](../operations.md) for backups, logs, metrics, and session limits. If notebook jobs are enabled, keep maintenance active for scheduling and cleanup.

## Validate

1. Check `/api/health` and the authenticated deep health report.
2. Sign in through the configured provider.
3. Create a notebook and start its kernel.
4. Install a private package from the notebook environment.
5. Save the notebook and restart the hub.
6. Check that the notebook persists and the kernel reconnects.
7. If managed AI is enabled, send a request from the notebook assistant.

## Troubleshooting

For CodeArtifact failures, check the notebook role, helper `PATH`, repository URL, and token expiry. For deployment failures, see [Troubleshooting](../troubleshooting.md).

## See also

[Storage](../storage.md) · [Compute](../compute.md) · [Auth](../auth.md) · [Configuration](../configuration.md)
