# Releasing

## For maintainers only

Releases are cut via a PR, never by pushing to `main` or hand-pushing tags.

1. Run `pnpm release <X.Y.Z | patch | minor | major>`. This keeps the root,
   Cargo package, and lockfile versions in sync on a fresh branch off
   `origin/main`, then opens a PR titled `release: X.Y.Z`. The binary wheel
   derives its version from Cargo.
2. Merge it. [`release-tag.yml`](../.github/workflows/release-tag.yml) verifies
   the PR title matches `package.json`, then creates and pushes the `vX.Y.Z`
   tag using a GitHub App token (tags pushed with the default `GITHUB_TOKEN`
   do not trigger workflows).
3. The tag push triggers [`release.yml`](../.github/workflows/release.yml),
   which publishes the container image and the Helm chart to GHCR, builds the
   cross-platform `mohub` binaries and binary-only wheels, and creates a GitHub
   release whose changelog is generated from
   the commits since the previous tag ([changelogithub](https://github.com/antfu/changelogithub),
   so conventional-commit prefixes like `feat:`/`fix:` drive the grouping).

The x86-64 Linux build uses a glibc 2.28 image. Each native archive contains
shell completions and man pages.

[`apps/cli/dist-workspace.toml`](../apps/cli/dist-workspace.toml) defines shell,
PowerShell, Homebrew, and npm installers. It also defines the standalone
`mohub-update` program. Run `dist plan --allow-dirty` from `apps/cli` to check
this configuration. The existing workflow remains the release owner while the
team creates the Homebrew tap and configures npm credentials.

End users then upgrade with:

```sh
helm upgrade --install marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version X.Y.Z -n marimohub -f values.yaml
```
