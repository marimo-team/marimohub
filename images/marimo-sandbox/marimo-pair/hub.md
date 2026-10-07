## Connect inside marimohub

When `MARIMOHUB_KERNEL_URL` is set, the scripts use that kernel, including its
proxy prefix, without registry discovery. `execute-code.sh` reads
`MARIMOHUB_KERNEL_TOKEN_FILE` automatically. An explicit `--url` for another
kernel does not receive this token.

Start with the required inspection:

```bash
bash /absolute/path/to/marimo-pair/scripts/execute-code.sh \
  -c "import marimo._code_mode as cm; help(cm)"
```

Use the same defaults for subsequent calls. Do not print the token or put it in commands.
If no session is active, open the existing notebook in marimo.
Do not start another server or disable authentication.

Outside marimohub, follow the discovery instructions below.
