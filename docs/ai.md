# Managed AI

Give every notebook a working AI assistant without asking users for their own
API key. When managed AI is on, marimohub points marimo's assistant at a provider
**you** configure and pays for, so chat, autocomplete, and "generate with AI" just
work the moment someone opens a notebook.

It's optional and off by default. Turn it on by setting one upstream provider; the
real provider key stays on the server and is never exposed to notebook code.

## Configuration

Set `MARIMOHUB_AI_BACKEND=openai-compatible` plus the upstream details. When
configured, managed AI is injected into **every** session deployment-wide.

<!--@include: ./setup/ai/openai-compatible.md-->

The full set of variables:

| Variable                         | Required | Description                                                                                                          |
| -------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `MARIMOHUB_AI_BACKEND`           | —        | `none` (default) or `openai-compatible`.                                                                             |
| `MARIMOHUB_AI_UPSTREAM_BASE_URL` | yes      | Upstream OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`. The proxy POSTs to `<base>/chat/completions`. |
| `MARIMOHUB_AI_UPSTREAM_API_KEY`  | yes      | The real upstream key. Held server-side; never injected into a sandbox.                                              |
| `MARIMOHUB_AI_MODEL`             | yes      | Default model id surfaced to marimo, e.g. `gpt-4o-mini`.                                                             |
| `MARIMOHUB_AI_ALLOWED_MODELS`    | no       | Comma-separated allowlist; off-list requests fall back to the default model.                                         |
| `MARIMOHUB_AI_UPSTREAM_PROJECT`  | no       | Optional `OpenAI-Project` header forwarded upstream (e.g. W&B Inference `entity/project` attribution).               |
| `MARIMOHUB_AI_MAX_TOKENS`        | no       | `[ai] max_tokens` written into the notebook config.                                                                  |
| `MARIMOHUB_AI_RULES`             | no       | `[ai] rules` — custom assistant instructions.                                                                        |
| `MARIMOHUB_AI_TOKEN_TTL_SECONDS` | no       | Session-token lifetime in seconds (default 3600).                                                                    |
| `MARIMOHUB_AI_XDG_PATH`          | no       | Where the injected `marimo.toml` lives (default `/tmp/marimohub-config`; must be writable by the sandbox user).      |

Managed AI also requires `MARIMOHUB_AUTH_SESSION_SECRET` — the per-session tokens
are signed with it (the same secret that signs login cookies).

## Providers

Any OpenAI-compatible endpoint works. Set `MARIMOHUB_AI_UPSTREAM_BASE_URL` to the
provider's base and `MARIMOHUB_AI_MODEL` to one of its model ids:

| Provider              | Base URL                            | Notes                                               |
| --------------------- | ----------------------------------- | --------------------------------------------------- |
| OpenAI                | `https://api.openai.com/v1`         | `gpt-4o-mini`, `gpt-4o`, …                          |
| OpenRouter            | `https://openrouter.ai/api/v1`      | One key, hundreds of models across vendors.         |
| W&B Inference         | `https://api.inference.wandb.ai/v1` | Set `MARIMOHUB_AI_UPSTREAM_PROJECT=entity/project`. |
| Anthropic (compat.)   | `https://api.anthropic.com/v1`      | Anthropic's OpenAI-compatible endpoint.             |
| LiteLLM / self-hosted | `https://<your-litellm-host>/v1`    | Front many providers behind one gateway.            |

## How it works

1. **Inject.** At session start, marimohub writes a `marimo.toml` into the sandbox
   (in an XDG config dir, outside the notebook's files) that registers a custom AI
   provider pointed at marimohub's own proxy, using a short-lived, session-scoped
   token as the `api_key`.
2. **Proxy.** marimohub hosts an OpenAI-compatible endpoint at `/api/ai/v1`. It
   verifies the session token, then forwards the request to your upstream with the
   **real** key (held server-side), streaming the response back.

Notebook kernels run untrusted code, so the real provider key is never written into
a sandbox — only a minted, expiring, session-scoped token. This mirrors how
[Workload Identity Federation](/coreweave-bucket-access) avoids long-lived storage
keys.

## Proxy contract

The proxy implements the subset of the OpenAI API that marimo calls server-side.
All endpoints require a valid bearer session token; the upstream key is added
server-side.

- `POST /api/ai/v1/chat/completions` — forwards to the upstream, streaming SSE when
  `stream: true`. The request `model` is normalized to a managed model.
- `POST /api/ai/v1/responses` — the same passthrough for the OpenAI Responses API,
  so a client pointed at marimo's built-in `[ai.open_ai]` provider also works.
- `GET /api/ai/v1/models` — returns the configured/allowed models.

This is a deliberate allowlist, not a generic OpenAI passthrough: the session token
authorizes untrusted notebook code, so the proxy exposes only the endpoints clients
need. Others (`/v1/embeddings`, `/v1/images`, …) are added only on demand.

## What the user can override

The injected config sits at the user-config tier, so a user who explicitly sets
`[tool.marimo.ai]` in their own `pyproject.toml` still overrides it — a deliberate
bring-your-own-key escape hatch. With managed AI **off** (`MARIMOHUB_AI_BACKEND=none`),
the assistant only works for users who supply their own key in marimo's settings.
