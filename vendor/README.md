# Vendored: `@coreweave/cwsandbox` (prebuilt tarball, temporary)

`coreweave-cwsandbox-0.3.0-beta.0-pr53.tgz` is a local build of
[coreweave/cwsandbox-js#53](https://github.com/coreweave/cwsandbox-js/pull/53)
(`hoare-templates`, commit `a6e3ad522d1e7ef4704f765aed8b10239e0eb88f`), which
adds `runFromTemplate` — the template-create API the CoreWeave adapter needs.
Committed as a tarball so the repo and CI install without registry access or
git credentials for the private upstream.

Replace with the npm release as soon as the PR ships in a published version:
point `packages/compute-coreweave/package.json` back at the registry version,
delete this directory, and update the pin in `pnpm-workspace.yaml`'s
`minimumReleaseAgeExclude`.

Rebuild (needs access to the private repo):

```bash
gh repo clone coreweave/cwsandbox-js -- --depth 1 --branch <branch>
cd cwsandbox-js && pnpm install --ignore-scripts
cd packages/cwsandbox && pnpm build && npm pack
```
