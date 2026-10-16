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

Before you tag, check that the latest [Chart workflow](../.github/workflows/chart.yml)
run on `main` passed. The workflow has path filters, so a red run stays red
until a chart change or a manual re-run. Both `chart.yml` and `release.yml` pin
Helm v4.3.1; change the two pins together.

### Tag validation

The `validate-tag` job runs first, and every release job depends on it. It runs
`scripts/release-tag.sh validate TAG`, which prints the version without the
leading `v` or exits 1. Only stable `vMAJOR.MINOR.PATCH` tags without leading
zeros pass (`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`).
Tags such as `v1.2` and `1.2.3` do not match the `v*.*.*` trigger, so no Release
run starts. Tags such as `v1.2.3-rc.1` and `v01.2.3` match the trigger and start a
run, but `validate-tag` fails and the workflow publishes nothing.

### Floating image tags

Every release pushes the `X.Y.Z`, `X.Y`, and `X` image tags. `latest` moves only
when the released tag is the highest stable `v*` tag in the repository
(`scripts/release-tag.sh floating TAG` decides; prerelease tags never count).

The `image` job creates each manifest list from the per-architecture build
digests (`@sha256:…`), never from mutable tags. Before it creates the list, it inspects
each source digest and requires that their linux platforms together are exactly
`linux/amd64` and `linux/arm64`, so a bad source set fails before any tag moves.
It checks the created list again, and it retries create and inspect. The job holds the
`release-image-manifest` concurrency lock, so two releases cannot interleave tag moves.

The x86-64 Linux build uses a glibc 2.28 image. Each native archive contains
shell completions and man pages.

The `marimohub` image supports `linux/amd64` and `linux/arm64` under the same tags.
Releases also include `marimohub-linux-x64` and `marimohub-linux-arm64`, standalone
Node SEA binaries with the server and SPA embedded. Each has a `.sha256` file
and provenance attestation. These binaries are not part of the CLI's `SHA256SUMS`
and SBOM, and the **Recover CLI release** workflow does not publish them.

On Linux or macOS, build a binary for the local architecture with `pnpm build:sea`.
The output is `apps/server/dist/sea/marimohub-<platform>-<arch>`.
Run `scripts/smoke-sea.sh <binary>` to check it, or
`gh attestation verify <binary> --repo marimo-team/marimohub` to check release provenance.
Releases build and check both Linux architectures with the
[binary workflow](../.github/workflows/server-binary.yml). In CI, the verify job
builds and smoke-tests the x64 binary from its own build output, and the binary
workflow covers arm64 only.

[`apps/cli/dist-workspace.toml`](../apps/cli/dist-workspace.toml) defines shell,
PowerShell, Homebrew, and npm installers. It also defines the standalone
`mohub-update` program. Run `dist plan --allow-dirty` from `apps/cli` to check
this configuration. The existing workflow remains the release owner while the
team creates the Homebrew tap and configures npm credentials.

## Recover a failed release

Tags are immutable. Do not delete or move a release tag. Fix the problem and
re-run jobs, or cut a new patch release.

If a publication job fails, first use **Re-run failed jobs** on the release workflow.
The publication jobs reuse the successful build artifacts and do not rebuild the CLI.

### Image and server binary jobs

Re-running a failed `image-build`, `image`, `server-binary`, or
`publish-server-binary` job is safe. The jobs use artifacts from the same run,
manifest creation is idempotent, and binary uploads replace existing assets.

After the `image` job passes, verify the multi-architecture manifest:

```sh
docker buildx imagetools inspect ghcr.io/marimo-team/marimohub:X.Y.Z
```

The output must list `linux/amd64` and `linux/arm64`. It also lists
`unknown/unknown` entries for the attestations.

### CLI release

If the workflow file caused a CLI publication failure, run the **Recover CLI release**
workflow ([`recover-cli-release.yml`](../.github/workflows/recover-cli-release.yml)) from `main`.
Provide the release tag and the run ID of the failed release workflow.
This workflow checks that the run built the specified tag.
It then publishes the stored CLI artifacts and recreates missing release metadata.
It does not build or publish images or server binaries.
You can run it more than once for the same tag.

End users then upgrade with:

```sh
helm upgrade --install marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version X.Y.Z -n marimohub -f values.yaml
```
