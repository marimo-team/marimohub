# @marimo-hub/credentials-aws

`CredentialBroker` adapter for Workload Identity Federation: exchanges a hub-issued OIDC JWT for temporary AWS credentials via STS `AssumeRoleWithWebIdentity`.

It also exports `createAwsSigV4Fetch({ region, service })`, a `fetch` wrapper that signs each request with AWS Signature V4 using the default credential chain (IRSA, EKS Pod Identity, env vars, …). The managed Amazon Bedrock AI backend (`MARIMOHUB_AI_BACKEND=bedrock`) passes it to the OpenAI-compatible provider so the hub authenticates upstream with its own runtime identity and no Bedrock API key exists to leak into a sandbox.

Part of [marimohub](../../README.md). See [docs/workload-identity-federation.md](../../docs/workload-identity-federation.md) for configuration.
