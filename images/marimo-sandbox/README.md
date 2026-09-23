# Maintained sandbox image

All targets require the `notebook_bridge` named build context to preinstall the
bundled notebook bridge. Older build commands without this context fail.

From the repository root, use:

```sh
docker build --build-context notebook_bridge=packages/notebook-bridge \
  -t marimo-sandbox:local images/marimo-sandbox
```

For an optional target, add `--target vscode`, `--target opencode`, or `--target tools`.
The publish workflow and acceptance script supply the context automatically:

```sh
examples/sandbox-image/acceptance-test.sh marimo-sandbox:local images/marimo-sandbox
```

For a standalone image without bridge preinstallation, use
[`examples/sandbox-image`](../../examples/sandbox-image/README.md). That Dockerfile
needs no named context. Hub installs the bridge at launch.

See the [sandbox image guide](../../docs/sandbox-image.md) for the runtime contract.
