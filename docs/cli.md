---
description: Install the mohub CLI, sign in, and run common commands.
---

# Command-line interface

Use `mohub` to manage marimohub projects, notebooks, sessions, and integrations.

## Install

Download the wheel for your platform from
[GitHub Releases](https://github.com/marimo-team/marimohub/releases). Install the
wheel with `uv`:

```bash
uv tool install ./marimohub_cli-*.whl
mohub --version
```

To try the wheel without an installation, run:

```bash
uv tool run --from ./marimohub_cli-*.whl mohub --version
```

If you do not use `uv`, download the standalone archive. Extract it and put
`mohub` (`mohub.exe` on Windows) on your `PATH`.

### GitHub Actions

Use [`setup-marimohub-cli`](https://github.com/marimo-team/setup-marimohub-cli)
to install a pinned CLI version and synchronize a git-backed notebook after a
push:

```yaml
name: Sync marimohub notebook

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: marimohub-sync-${{ github.ref }}
  cancel-in-progress: true

jobs:
  sync:
    runs-on: ubuntu-latest
    env:
      MARIMOHUB_URL: ${{ vars.MARIMOHUB_URL }}
      MARIMOHUB_TOKEN: ${{ secrets.MARIMOHUB_TOKEN }}
      MARIMOHUB_PROJECT_ID: ${{ vars.MARIMOHUB_PROJECT_ID }}
      MARIMOHUB_NOTEBOOK_ID: ${{ vars.MARIMOHUB_NOTEBOOK_ID }}
    steps:
      - uses: marimo-team/setup-marimohub-cli@15f7152034cdf6728c02be77d39526360ce60ec2 # v1.0.1
        with:
          version: '0.3.12'

      - name: Sync notebook
        run: >-
          mohub notebooks source sync
          --pid "$MARIMOHUB_PROJECT_ID"
          --nid "$MARIMOHUB_NOTEBOOK_ID"
          --yes
```

Synchronization is server-initiated, so the job does not need to check out the
repository. It is a no-op when the notebook already matches the configured
branch head. For production, keep the variables and token in a protected GitHub
Environment.

## Sign in

Create a profile for your server:

```bash
mohub profile set default --base-url https://hub.example.com
```

Run `mohub login`:

```bash
mohub login
```

The CLI opens the selected Hub in your browser. Review the account, token
lifetime, actions, and projects. Then select **Authorize CLI**. The default
lifetime is 30 days. The CLI requests a full grant in this release. You can
narrow that grant on the approval page. The page cannot add access beyond the
CLI request.

The CLI exchanges the one-time approval code and stores the token in the
operating system credential store.

If the browser does not open automatically, the CLI prints the loopback approval
URL. Open this URL on the same machine as the CLI.

For a remote or headless environment, use device login:

```bash
mohub login --device-code
```

The CLI prints a URL and an eight-letter code. It waits for approval for up to
ten minutes. Open the URL on any device and sign in.

WARNING: If the browser and terminal show different codes, do not approve the
request. An attacker can use a code that they send to you to access your account.

`--no-browser` is an alias for `--device-code`. Both login flows use PKCE and a
one-time grant. They preserve the requested token grant through approval and
exchange. The Hub never puts the personal access token in a browser URL.

Device login first uses the scoped authorization endpoint. It uses the legacy
endpoint only when the server returns 404. This fallback is safe because this
CLI release requests full access. A future narrow request must not use the
legacy fallback.

You can also create the default profile and sign in in one command:

```bash
mohub --base-url https://hub.example.com login
```

Browser login requires an origin URL without a path prefix. Path-prefixed Hub
deployments can use the non-interactive token flow below.
Non-loopback server URLs must use HTTPS. Local loopback URLs can use HTTP.

For non-interactive automation, create an API token in the Hub and send it
through standard input:

```bash
printf '%s' "$MARIMOHUB_TOKEN" | mohub login --token-stdin
```

Make sure that the connection works:

```bash
mohub status
mohub me
```

`mohub` stores the server URL in its profile file. It stores the token in the
operating system credential store. On Linux systems without a Secret Service,
it uses a user-only credentials file instead.

## Use the CLI

```bash
mohub projects list --all
mohub notebooks list --pid <PROJECT_ID> --all
mohub notebooks create --pid <PROJECT_ID> --title analysis \
	--code 'import marimo as mo' --description 'Analysis notebook'
mohub sessions list --pid <PROJECT_ID> --all
```

Use `--help` to see commands and options:

```bash
mohub --help
mohub notebooks --help
mohub projects --help
```

The default output is JSON. Select another output format with `--output`:

```bash
mohub projects list --all --output table
mohub projects list --all --output csv
mohub projects list --all --output jsonl
```

Use `json`, `jsonl`, `raw`, or `csv` in scripts. These formats do not contain
terminal colors. Progress and update notices use standard error.

The CLI skips its daily release check when standard error is not a terminal, including in CI. Use
`--no-update-check` or `MARIMOHUB_NO_UPDATE_CHECK=true` to disable it explicitly.

## Deploy notebooks from configuration

`mohub notebooks deploy` updates existing local-source notebooks from repository files. Before it
writes, the command compares each notebook, skips unchanged entries, and captures ETags to reject
concurrent updates.

For one `.py` file in the configuration directory, `marimohub.toml` needs two fields:

```toml
project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
```

Alternatively, put these fields under `[tool.marimohub]` in `pyproject.toml`:

```toml
[tool.marimohub]
project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
```

`path` and `readme_path` are relative to the configuration file. Without `path`, a single-notebook
configuration uses the only immediate `.py` file. Zero or multiple matches produce an error.

For multiple notebooks in `marimohub.toml`, use named tables:

```toml
project_id = "proj-7h2k9qm4xz7rp3w8"

[notebooks.revenue]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "notebooks/revenue.py"

[notebooks.inventory]
notebook_id = "nb-8h2k9qm4xz7rp3w8"
path = "notebooks/inventory.py"
```

In `pyproject.toml`, nest these tables under `[tool.marimohub]`. For example, use
`[tool.marimohub.notebooks.revenue]` instead of `[notebooks.revenue]`.

Every named table in a multi-notebook configuration requires `path`. Optional fields are `title`,
`description`, `tags`, `readme_path`, `base_image`, and `compute_profile`. Omitted fields preserve
their remote values. Set `base_image` or `compute_profile` to `false` to clear an override. String
values are literal names, including `"default"`. Override names and `title` cannot be empty.

Preview or deploy notebooks:

```bash
mohub notebooks deploy --dry-run
mohub notebooks deploy
mohub notebooks deploy --notebook revenue
mohub notebooks deploy --notebook revenue --notebook inventory
```

Use `--message` to set the immutable version message for code changes. Otherwise, the message is
`Deploy <path>`.

The CLI resolves configuration in this order:

1. `--config PATH`.
2. `MARIMOHUB_CONFIG`.
3. The nearest ancestor with `marimohub.toml` or a `[tool.marimohub]` section.

At the same directory level, `marimohub.toml` takes precedence over `pyproject.toml`.

The command prints one aggregate result. Each entry includes its action and changed field names.
Actions are `planned`, `updated`, or `unchanged`. Output excludes notebook and readme text.

The configuration cannot contain server URLs or credentials. Each declaration must identify an
existing local-source notebook. This command does not create or delete notebooks, upload
dependencies, or update git-backed sources. For git-backed workspaces, use the
[source sync workflow](./syncing.md).

In CI, set the Hub URL and token through the environment. Replace `<CLI_VERSION>` with a CLI version
that contains this command.

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
- uses: marimo-team/setup-marimohub-cli@15f7152034cdf6728c02be77d39526360ce60ec2 # v1.0.1
  with:
    version: '<CLI_VERSION>'
- name: Deploy notebooks
  env:
    MARIMOHUB_URL: ${{ vars.MARIMOHUB_URL }}
    MARIMOHUB_TOKEN: ${{ secrets.MARIMOHUB_TOKEN }}
  run: mohub notebooks deploy
```

## Profiles

Use profiles to connect to more than one marimohub deployment:

```bash
mohub profile list
mohub profile set work --base-url https://work.example.com
mohub profile use work
```

Use `--profile <NAME>` to select a profile for one command.

## Shell completions

Generate a completion file for Bash, Elvish, Fish, Nushell, PowerShell, or Zsh:

```bash
mohub completions zsh > ~/.zfunc/_mohub
```

Standalone release archives also contain completion files and man pages.

## Upgrade

Standalone shell and PowerShell installations include `mohub-update`. Homebrew,
npm, and other package-manager installations use their package manager.

## Log out

Remove the token from your local credential store:

```bash
mohub logout
```

This command does not revoke the token. Revoke an exposed token from **API tokens**
in the web app.

For more information about token expiry and access, see [API tokens](./api-tokens.md).
