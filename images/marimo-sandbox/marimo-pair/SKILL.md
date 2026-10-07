---
name: marimo-pair
description: Work in the live marimo notebook kernel to inspect state, run Python, and edit notebook cells.
---

Read `uv run --no-sync marimo pair --help` for the workflow and code-mode API.
Use `marimo pair docs` for additional notebook guidance.

Use `MARIMOHUB_KERNEL_URL` to attach to the existing kernel. Keep its proxy prefix.
The local server registry can be empty with authentication or a different `XDG_STATE_HOME`.
Pass the token file path to the CLI without reading or printing its contents:

```bash
kernel_args=(--url "$MARIMOHUB_KERNEL_URL")
if [[ -n "${MARIMOHUB_KERNEL_TOKEN_FILE:-}" ]]; then
  kernel_args+=(--token-file "$MARIMOHUB_KERNEL_TOKEN_FILE")
fi
uv run --no-sync marimo pair execute "${kernel_args[@]}" \
  -c 'import marimo._code_mode as cm; help(cm)'
```

Include these arguments on every `execute` and `notebook list` call.
Use `--file` to select a notebook when more than one is open.
For another server, use its URL and credentials instead of the hub connection arguments.

If no session is active, open the existing notebook in marimo.
Do not start another server or disable authentication.
Edit the live notebook through code mode, not its `.py` file.
