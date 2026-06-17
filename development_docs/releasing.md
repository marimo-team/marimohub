# Releasing

## For maintainers only

Releases are cut via a PR, never by pushing to `main` or hand-pushing tags.

1. Run `pnpm release <X.Y.Z | patch | minor | major>`. This bumps `version` in
   the root `package.json` on a fresh branch off `origin/main` and opens a PR
   titled `release: X.Y.Z`.
2. Merge it. [`release-tag.yml`](../.github/workflows/release-tag.yml) verifies
   the PR title matches `package.json`, then creates and pushes the `vX.Y.Z`
   tag using a GitHub App token (tags pushed with the default `GITHUB_TOKEN`
   do not trigger workflows).
3. The tag push triggers [`release.yml`](../.github/workflows/release.yml),
   which publishes the container image and the Helm chart to GHCR, all pinned
   to `X.Y.Z`, and creates a GitHub release whose changelog is generated from
   the commits since the previous tag ([changelogithub](https://github.com/antfu/changelogithub),
   so conventional-commit prefixes like `feat:`/`fix:` drive the grouping).

End users then upgrade with:

```sh
helm upgrade --install marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version X.Y.Z -n marimohub -f values.yaml
```
