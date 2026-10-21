<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->

<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:#7C3AED;vertical-align:-1px"></span> `agent_context` · other · config schema v1

::: details Agent context configuration reference

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `instructions` | string |  |  | Shared Markdown instructions for coding agents |
| `skills` | object[] |  |  |  |
| `skills[].name` | string | Yes |  |  |
| `skills[].content` | string | Yes |  | Complete SKILL.md, including YAML frontmatter |
| `opencode_json` | string |  |  | OpenCode JSON configuration; reference custom environment variables for tokens |
| `claude_settings_json` | string |  |  | Claude Code user settings JSON; do not include secrets |

:::
