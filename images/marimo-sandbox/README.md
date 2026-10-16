# Maintained sandbox image

The manifest tags `latest`, `py3.13-marimo<version>`, and `sha-<commit>` support
`linux/amd64` and `linux/arm64`, as do their `-vscode`, `-opencode`, and `-tools` variants.
Source tags ending in `-amd64` or `-arm64` contain only that architecture.

Build from the repository root with the required `notebook_bridge` context:

```sh
docker build --build-context notebook_bridge=packages/notebook-bridge \
  -t marimo-sandbox:local images/marimo-sandbox
```

For an optional target, add `--target vscode`, `--target opencode`, or `--target tools`.
The publish workflow and acceptance script supply the context automatically:

```sh
examples/sandbox-image/acceptance-test.sh marimo-sandbox:local images/marimo-sandbox
```

CI checks the OpenCode server with `check-opencode.sh` (health deadline: `OPENCODE_HEALTH_DEADLINE`, default 60 s).
Test it with `python3 images/marimo-sandbox/test-opencode-check.py`; it needs `bash`, `curl`, and `jq`.

For a standalone image without bridge preinstallation, use
[`examples/sandbox-image`](../../examples/sandbox-image/README.md). That Dockerfile
needs no named context. Hub installs the bridge at launch.

See the [sandbox image guide](../../docs/sandbox-image.md) for the runtime contract.
