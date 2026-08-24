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
to install a pinned CLI version in a workflow:

```yaml
- uses: marimo-team/setup-marimohub-cli@v1
  with:
    version: '0.3.6'
```

The CLI reads automation credentials from `MARIMOHUB_URL` and
`MARIMOHUB_TOKEN`. Store the token as a GitHub Actions secret.

To synchronize a git-backed notebook after a push, configure
`MARIMOHUB_PROJECT_ID` and `MARIMOHUB_NOTEBOOK_ID` as repository variables and
run:

```yaml
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

Sign in to marimohub in your browser. Open the user menu, select **API tokens**,
and create a token with an expiry date. The app shows the token one time.

Create a profile for your server:

```bash
mohub profile set default --base-url https://hub.example.com
```

Run `mohub login` and paste the token at the hidden prompt:

```bash
mohub login
```

For a script, send the token through standard input:

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
