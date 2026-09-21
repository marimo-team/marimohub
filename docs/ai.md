---
description: Configure a server-managed OpenAI-compatible provider for notebook AI features.
---

# Managed AI

Give every notebook a working AI assistant without asking users for their own
API key. When managed AI is on, marimohub points marimo's assistant at a provider
**you** configure and pays for. Chat, autocomplete, and "generate with AI" work
when someone opens a notebook.

It's optional and off by default. Turn it on by setting one upstream provider;
provider credentials stay on the server and are never exposed to notebook code.

## Configuration

Select Bedrock or an API-key-backed OpenAI-compatible upstream. When configured,
managed AI is injected into **every** session deployment-wide.

### Amazon Bedrock

<!--@include: ./setup/ai/bedrock.md-->

### OpenAI-compatible provider

<!--@include: ./setup/ai/openai-compatible.md-->

The full set of variables:

| Variable                         | Required | Description                                                                                                                                                                          |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MARIMOHUB_AI_BACKEND`           | —        | `none` (default), `bedrock`, or `openai-compatible`.                                                                                                                                 |
| `MARIMOHUB_AI_AWS_REGION`        | Bedrock  | AWS region for Bedrock. Falls back to `AWS_REGION` or `AWS_DEFAULT_REGION`.                                                                                                          |
| `MARIMOHUB_AI_UPSTREAM_BASE_URL` | API key  | Upstream OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`. The proxy POSTs to `<base>/chat/completions`.                                                                 |
| `MARIMOHUB_AI_UPSTREAM_API_KEY`  | API key  | The real upstream key. Held server-side; never injected into a sandbox.                                                                                                              |
| `MARIMOHUB_AI_MODEL`             | yes      | Default model id surfaced to marimo, e.g. `gpt-4o-mini`.                                                                                                                             |
| `MARIMOHUB_AI_ALLOWED_MODELS`    | no       | Comma-separated allowlist; off-list requests fall back to the default model. Unset allows any model on OpenAI-compatible upstreams; on Bedrock it restricts to `MARIMOHUB_AI_MODEL`. |
| `MARIMOHUB_AI_UPSTREAM_PROJECT`  | no       | Optional `OpenAI-Project` header forwarded upstream (e.g. W&B Inference `entity/project` attribution).                                                                               |
| `MARIMOHUB_AI_MAX_TOKENS`        | no       | `[ai] max_tokens` written into the notebook config.                                                                                                                                  |
| `MARIMOHUB_AI_RULES`             | no       | `[ai] rules` — custom assistant instructions.                                                                                                                                        |
| `MARIMOHUB_AI_TOKEN_TTL_SECONDS` | no       | AI session-token lifetime in seconds (default: `3600`). Shorter lifetimes reduce the revocation window.                                                                              |

Managed AI also requires `MARIMOHUB_AUTH_SESSION_SECRET` — the per-session tokens
are signed with it (the same secret that signs login cookies).

## Providers

For API-key-backed providers, any OpenAI-compatible endpoint works. Set
`MARIMOHUB_AI_UPSTREAM_BASE_URL` to the provider's base and
`MARIMOHUB_AI_MODEL` to one of its model ids:

| Provider              | Base URL                            | Notes                                               |
| --------------------- | ----------------------------------- | --------------------------------------------------- |
| OpenAI                | `https://api.openai.com/v1`         | `gpt-4o-mini`, `gpt-4o`, …                          |
| OpenRouter            | `https://openrouter.ai/api/v1`      | One key, hundreds of models across vendors.         |
| W&B Inference         | `https://api.inference.wandb.ai/v1` | Set `MARIMOHUB_AI_UPSTREAM_PROJECT=entity/project`. |
| Anthropic (compat.)   | `https://api.anthropic.com/v1`      | Anthropic's OpenAI-compatible endpoint.             |
| LiteLLM / self-hosted | `https://<your-litellm-host>/v1`    | Front many providers behind one gateway.            |

## How it works

1. **Inject.** At session start, marimohub sets `XDG_CONFIG_HOME` and writes a
   `marimo.toml` into that sandbox-local config directory, outside the notebook's
   files. The config registers a custom AI provider pointed at marimohub's own
   proxy using a short-lived, session-scoped token as the `api_key`.
2. **Proxy.** marimohub hosts an OpenAI-compatible endpoint at `/api/ai/v1`. It
   verifies the session token, authenticates the upstream request server-side, and
   streams the response back.

Notebook kernels run untrusted code, so provider credentials are never written into
a sandbox — only a minted, expiring, session-scoped token. This mirrors how
[Workload Identity Federation](/workload-identity-federation) avoids long-lived storage
keys.

::: warning Token revocation is not immediate
The proxy checks token signatures, expiration, and user suspension on each request.
It rejects suspended users and fails closed if it cannot check suspension status.
Stopping a session or removing project access does not invalidate its token.

The default lifetime is one hour. Set `MARIMOHUB_AI_TOKEN_TTL_SECONDS` to a lower
value to reduce the revocation window. AI access ends when the token expires, even
if the notebook session remains active.
:::

## Proxy contract

The proxy exposes the OpenAI endpoints marimo needs. Each requires a bearer
session token. The hub authenticates upstream requests.

- `POST /api/ai/v1/chat/completions` — forwards to the upstream, using Converse
  for Bedrock Claude and SSE for `stream: true`. The hub resolves `model` against
  the configured allowlist.
- `POST /api/ai/v1/responses` — forwards requests to the upstream Responses API.
  The provider and model must support Responses. There is no Converse translation.
- `GET /api/ai/v1/models` — lists allowed models, or the default if no allowlist is set.

The Bedrock Claude bridge supports:

- Text in `system`, `developer`, `user`, and `assistant` messages. System and
  developer messages combine into system instructions.
- `stream`, `temperature`, `top_p`, and `stop`.
- Token limits, in precedence order: `max_completion_tokens`, `max_tokens`, then
  `MARIMOHUB_AI_MAX_TOKENS`. The configuration supplies a default, not a hard cap.

The bridge ignores other fields, tool messages, tool calls, and non-text content.
Tool-dependent clients, including OpenCode agents, need a provider with tool support.

Request bodies have a 10 MB limit, including embedded files. Larger requests receive
HTTP `413` before reaching the provider.

Other OpenAI endpoints, including embeddings and images, are not exposed.

## What the user can override

The injected config sits at the user-config tier, so a user who explicitly sets
`[tool.marimo.ai]` in their own `pyproject.toml` still overrides it — a deliberate
bring-your-own-key escape hatch. With managed AI **off** (`MARIMOHUB_AI_BACKEND=none`),
the assistant only works for users who supply their own key in marimo's settings.

[OpenCode](./surfaces.md#opencode-ai-providers) uses the same proxy through a
temporary `marimohub` provider. Project `opencode.json` files and `/connect`
providers can override it. The token expires at the configured TTL. Restart
OpenCode to get a new token.
