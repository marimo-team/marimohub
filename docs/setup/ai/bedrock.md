<!-- Setup snippet — included by docs/ai.md and rendered in the deployment wizard. -->

The hub uses Bedrock Converse for Claude chat and SQL generation, and the
OpenAI-compatible endpoint for other requests. It signs requests with its AWS
identity through SigV4. Credentials stay outside sandboxes.

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

Claude IDs support `anthropic.`, regional profiles such as `eu.anthropic.` and
`us.anthropic.`, and `global.anthropic.` profiles. The runtime identity must have
access to the model or profile in the selected region.

Startup skips the AI probe only when the default and all allowed models are Claude,
to avoid billable inference. Mixed allowlists still probe the OpenAI endpoint.
Claude model access is checked on the first request.

Claude supports text chat with JSON or streaming responses, without tools, images,
or Responses translation. See the [proxy contract](/ai#proxy-contract) for supported fields.
