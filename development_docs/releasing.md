# Releasing

Run `pnpm release patch` (or `minor`, `major`, or a stable `X.Y.Z`) to request a release PR.
Review and merge the PR after CI passes. Then another `marimo-eng` member approves tagging
in the protected `release` environment. Preparation needs no environment approval.
See the [maintainer runbook](https://github.com/marimo-team/github-maintenance/blob/main/docs/releases.md) (internal) for approvals, access, and setup.

The PR updates the root, CLI, and IaC package versions together.
The tag publishes containers, the Helm chart, CLI, and server binaries.
The IaC npm package has a [separate publication step](#integration-iac-package).

Before merging, check the latest [Chart workflow](../.github/workflows/chart.yml) passed.
Its path filters can leave an earlier failed run unresolved.
Keep the Helm version pins in the chart and release workflows aligned.

## Release artifacts

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

## Integration IaC package

`pnpm release` updates the IaC package version.
The Deno example imports the SDK sources from a pinned commit of this repository.
After a release, move that pin (`examples/integration-iac/deno/deno.json`) to the release commit when `packages/iac` changed.
The [Integration IaC SDK workflow](../.github/workflows/iac.yml) tests the packed package in Node and Deno.
Publication requires a manual run from a matching release tag.

### Configure trusted publishing once

1. Create the `npm` environment in GitHub.
2. npm registers trusted publishers only for existing packages. For a new package, publish the
   first version by hand from the release tag. Use an npm account with 2FA:

   ```sh
   git checkout vX.Y.Z
   pnpm install --frozen-lockfile
   pnpm --filter @marimo-hub/iac build
   cd packages/iac
   npm publish --access public --ignore-scripts
   ```

   Enter the one-time password when npm asks. Then run `npm view @marimo-hub/iac version`.

3. Configure the package's npm trusted publisher with these values:

| npm setting          | Value                      |
| -------------------- | -------------------------- |
| Provider             | GitHub Actions             |
| Organization or user | `marimo-team`              |
| Repository           | `marimohub`                |
| Workflow filename    | `iac.yml`                  |
| Environment name     | `npm`                      |
| Allowed actions      | Allow direct `npm publish` |

Registration requires package write access and account 2FA.
See [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
The workflow uses OIDC, requires no `NPM_TOKEN`, and receives automatic provenance for this public package and repository.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for configuration details.

### Publish a release

Run **Integration IaC SDK** from the matching `vX.Y.Z` tag with `publish` selected.
The root and IaC package versions must match the tag.
Each publication requires a new version. npm cannot republish an existing version.

The workflow builds the tarball in a job without OIDC permission.
The publish job downloads that artifact and runs `npm publish --ignore-scripts`.
Only this job has `id-token: write`. It uses Node 24 and requires npm >= 11.5.1.
Runs for the same tag cannot cancel an active publication.

After publication, consumers run `deno install` in their copied example and commit `deno.lock`.

## Local preparation

Install Node 22+, Git, Docker with a running local daemon, and the shared
[`gh release-control` command](https://github.com/marimo-team/internal-gh-actions#release-command).
Authenticate with `gh auth login`.

The shortcut prepares fresh `main` in a credential-free Docker container and opens the PR
using your GitHub login. Your checkout stays untouched. Normal PR review and CI still apply.
Use `gh release-control request patch --dry-run` to validate without creating a PR.
Use `gh release-control status` to follow the PR, final approval, and publication.
