<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#7C3AED;vertical-align:-1px"></span> `agent_context` · other · config schema v1

::: details Agent context configuration reference

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `instructions` | string |  |  | Shared Markdown instructions for coding agents. Maximum 32768 UTF-8 bytes. |
| `skills` | object[] |  |  |  |
| `skills[].name` | string | Yes |  |  |
| `skills[].content` | string | Yes |  | Complete SKILL.md, including YAML frontmatter. Maximum 65536 UTF-8 bytes. |
| `opencode_json` | string |  |  | OpenCode JSON configuration; reference custom environment variables for tokens. Maximum 16384 UTF-8 bytes. |
| `claude_settings_json` | string |  |  | Claude Code user settings JSON; do not include secrets. Maximum 16384 UTF-8 bytes. |

:::
