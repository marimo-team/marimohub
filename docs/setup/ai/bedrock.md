<!-- Setup snippet — included by docs/ai.md and rendered in the deployment wizard. -->

Use Amazon Bedrock's OpenAI-compatible endpoint with the hub's AWS identity.
The hub signs upstream requests with SigV4; no Bedrock API key or AWS credential
is written into a sandbox.

```bash
MARIMOHUB_AI_BACKEND=bedrock
MARIMOHUB_AI_AWS_REGION=eu-west-1
MARIMOHUB_AI_MODEL=eu.anthropic.claude-opus-4-7
# MARIMOHUB_AI_ALLOWED_MODELS=model-a,model-b
```

The runtime identity needs `bedrock:InvokeModel` and
`bedrock:InvokeModelWithResponseStream` for the configured inference profiles or
foundation models. On EKS, use IRSA or EKS Pod Identity; the standard AWS
credential chain also supports local development credentials.

When `MARIMOHUB_AI_ALLOWED_MODELS` is unset, Bedrock is restricted to
`MARIMOHUB_AI_MODEL`. Set an explicit comma-separated allowlist to expose more
models.
