# Releasing

## Release procedure

Releases are cut via a PR, never by pushing to `main` or hand-pushing tags.

1. Run `pnpm release <X.Y.Z | patch | minor | major>` with authenticated `gh`.
   This dispatches [Prepare release PR](../.github/workflows/release-pr.yml) from
   `main`; it does not change your local branch or working tree. Follow the run with
   `gh run list --workflow release-pr.yml`, or use the Actions page directly.
   The workflow updates the root, CLI Cargo package and lockfile, IaC package, and
   Deno example imports. The release App opens `release/X.Y.Z` with title
   `release: X.Y.Z`. Review and CI happen on that PR. Versions must increase.
2. Merge it. [`release-tag.yml`](../.github/workflows/release-tag.yml) verifies
   the same-repository branch, PR title, and package versions, then calls the shared
   release-tag action to create the annotated `vX.Y.Z` tag at the merge commit.
   The App-created tag triggers publishing.
3. The tag push triggers [`release.yml`](../.github/workflows/release.yml),
   which publishes the container image and the Helm chart to GHCR, builds the
   cross-platform `mohub` binaries and binary-only wheels, and creates a GitHub
   release whose changelog is generated from the commits since the last
   published release ([changelogithub](https://github.com/antfu/changelogithub),
   so conventional-commit prefixes like `feat:`/`fix:` drive the grouping). If
   a tag's release never shipped, its commits roll into the next release's
   notes.

Before you merge, check that the latest [Chart workflow](../.github/workflows/chart.yml)
run on `main` passed. The workflow has path filters, so a red run stays red
until a chart change or a manual re-run. Both `chart.yml` and `release.yml` pin
Helm v4.3.1; change the two pins together.

### Who can release

GitHub requires repository Write access to [dispatch a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
The preparation workflow has no additional team or actor allowlist, so Write,
Maintain, and Admin collaborators can start it. Read-only and fork contributors
cannot dispatch it on this repository. API credentials must also permit workflow dispatch.

Starting preparation opens a PR; it does not publish assets. Merging the release PR
starts tagging and publication. Merge permission, required checks, and review rules
come from repository settings, not these actions. The release App does not approve
or merge its own PRs.

The documented policy is to release through a PR. The current tag rules prevent
moving or deleting tags, but do not restrict creating them. A writer can still
create a matching version tag manually. Tag/manifest equality and main ancestry do
not prove release-PR provenance. Enforcing PR-only releases requires a tag-creation
ruleset for `v*` with the release App as the allowed creator. Restricting releases to
a smaller maintainer group also requires an explicit merge or environment approval
policy; the workflow does not implement that restriction.

### Release App

Configure `RELEASE_APP_ID` as a repository variable and `RELEASE_APP_PRIVATE_KEY`
as a repository secret. Install the App on this repository with Contents write
permission and Pull requests write permission. Approve the installation permission
update after changing the App. The tagging job requests only Contents write; the
PR preparation job requests Contents and Pull requests write. Both are scoped to this repository.
It does not need branch-protection bypass or pull-request approval permission.
The App token is minted after release validation and is not persisted in Git config.

Tag creation uses the exact merged commit, even if `main` has advanced. A rerun
accepts an existing tag only if it resolves to that commit; it never moves a tag.
An existing tag does not trigger publication again: re-run the failed release jobs.

### Tag validation

The `validate-tag` job runs first, and every release job depends on it. The shared
`validate-release` action requires a stable tag matching the root manifest version,
a checkout at that tag, and ancestry on `origin/main`. Only `vMAJOR.MINOR.PATCH`
without leading zeros passes. Prereleases fail before publication.

The shared actions live in [internal-gh-actions](https://github.com/marimo-team/internal-gh-actions)
and are pinned by commit SHA in the preparation, tagging, and publication workflows.
Update these pins together. Repository-specific version preparation stays in
`scripts/prepare-release.mjs`; shared actions never run package preparation commands.
Notifications aggregate all required publishers, including cancelled or skipped jobs.

If preparation finds that `main` advanced, rerun it. An identical release branch and
open PR are reused. Different changes on that branch are never overwritten; inspect
and resolve the pending release before retrying. Reopen a closed release PR explicitly.

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

## Integration IaC package

`pnpm release` updates the IaC package version and Deno example imports.
The [Integration IaC SDK workflow](../.github/workflows/iac.yml) tests the packed package in Node and Deno.
Publication requires a manual run from a matching release tag.

### Configure trusted publishing once

1. Create the `npm` environment in GitHub.
2. For a new package, publish the initial version before publisher registration.
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
After the initial publication, use a new version. npm cannot republish an existing version.

The workflow builds the tarball in a job without OIDC permission.
The publish job downloads that artifact and runs `npm publish --ignore-scripts`.
Only this job has `id-token: write`. It uses Node 24 and requires npm >= 11.5.1.
Runs for the same tag cannot cancel an active publication.

After publication, consumers run `deno install` in their copied example and commit `deno.lock`.
