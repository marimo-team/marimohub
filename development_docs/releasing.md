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
   release whose changelog is generated from the commits since the last
   published release ([changelogithub](https://github.com/antfu/changelogithub),
   so conventional-commit prefixes like `feat:`/`fix:` drive the grouping). If
   a tag's release never shipped, its commits roll into the next release's
   notes.

The x86-64 Linux build uses a glibc 2.28 image. Each native archive contains
shell completions and man pages.

The release also attaches `marimohub-linux-x64`, a standalone server binary
built with Node's single executable application (SEA) support by
[`scripts/build-sea.mjs`](../scripts/build-sea.mjs). It is the runner's `node`
with the server bundle and the SPA injected as assets; on first start it unpacks
them to a cache directory and loads the bundle from there. The container image
stays the primary distribution; the binary is a convenience for hosts without
Node. It carries its own `.sha256` and a build provenance attestation (verify
with `gh attestation verify marimohub-linux-x64 --repo marimo-team/marimohub`),
but it is not in the CLI `SHA256SUMS` or SBOM, and the recovery workflow does
not rebuild it.
Build it locally with `pnpm build:sea` (outputs
`apps/server/dist/sea/marimohub-<platform>-<arch>`) and check it with
`scripts/smoke-sea.sh <binary>`. CI's `verify` job runs both on every PR, so a
broken build or launcher fails there rather than halfway through a release.

[`apps/cli/dist-workspace.toml`](../apps/cli/dist-workspace.toml) defines shell,
PowerShell, Homebrew, and npm installers. It also defines the standalone
`mohub-update` program. Run `dist plan --allow-dirty` from `apps/cli` to check
this configuration. The existing workflow remains the release owner while the
team creates the Homebrew tap and configures npm credentials.

## Recover a CLI release

If a publication job fails, first use **Re-run failed jobs** on the release workflow.
The publication jobs reuse the successful build artifacts and do not rebuild the CLI.

If the workflow file caused the failure, run the **Recover CLI release** workflow from `main`.
Provide the release tag and the run ID of the failed release workflow.
The recovery workflow checks that the run built the specified tag.
It then publishes the stored artifacts and recreates missing release metadata.
You can run the recovery workflow more than once for the same tag.

End users then upgrade with:

```sh
helm upgrade --install marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version X.Y.Z -n marimohub -f values.yaml
```
