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
      MARIMOHUB_NO_UPDATE_CHECK: '1'
      MARIMOHUB_PROJECT_ID: ${{ vars.MARIMOHUB_PROJECT_ID }}
      MARIMOHUB_NOTEBOOK_ID: ${{ vars.MARIMOHUB_NOTEBOOK_ID }}
    steps:
      - uses: marimo-team/setup-marimohub-cli@05c7d2bf3eb69f735ee6b56c7af9cfd10fe6678e # v1.0.0
        with:
          version: '0.3.6'

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

The CLI starts a temporary loopback server and opens the selected marimohub in
your browser. Review the account and token lifetime (30 days by default), then
select **Authorize CLI**. The Hub returns a short-lived, single-use code to the
loopback server; the CLI exchanges it for a token and stores the token in the
operating system credential store. The token is never placed in a browser URL.

If a browser is available on the same machine but cannot be opened automatically,
print the approval URL instead:

```bash
mohub login --no-browser
```

The browser must run on the same machine as the CLI because authorization returns
to a temporary loopback listener. For a remote or fully headless shell, create an
API token in the Hub and use `mohub login --token-stdin`.

You can also create the default profile and sign in in one command:

```bash
mohub --base-url https://hub.example.com login
```

Browser login requires an origin URL without a path prefix. Path-prefixed Hub
deployments can use the non-interactive token flow below.

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

Use `--no-update-check` or `MARIMOHUB_NO_UPDATE_CHECK=1` to turn off the daily
release check.

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
npm, and MSI installations use their package manager.

## Log out

Remove the token from your local credential store:

```bash
mohub logout
```

This command does not revoke the token. Revoke an exposed token from **API tokens**
in the web app.

For more information about token expiry and access, see [API tokens](./api-tokens.md).
