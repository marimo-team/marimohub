<!-- Setup snippet — included by docs/ai.md and rendered in the deployment wizard. -->

Point the hub at any OpenAI-compatible provider. Notebooks get the AI assistant
with **no key of their own** — the hub holds the real key server-side and proxies
requests through `/api/ai/v1`.

```bash
MARIMOHUB_AI_BACKEND=openai-compatible
MARIMOHUB_AI_UPSTREAM_BASE_URL=https://api.openai.com/v1
MARIMOHUB_AI_UPSTREAM_API_KEY=sk-...          # real key, held server-side
MARIMOHUB_AI_MODEL=gpt-4o-mini                 # default model offered to users
# MARIMOHUB_AI_ALLOWED_MODELS=gpt-4o-mini,gpt-4o   # optional allowlist
```

::: info Reuses the session secret
Per-session tokens are signed with `MARIMOHUB_AUTH_SESSION_SECRET`, so that must
be set too (it also signs login cookies). The real upstream key is **never**
written into a sandbox.
:::

Works with OpenAI, OpenRouter, LiteLLM, W&B Inference, or Anthropic's
OpenAI-compatible endpoint. See [Managed AI](/ai) for the provider table.
