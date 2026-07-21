# Vendored: `@coreweave/cwsandbox`

This is a **vendored build** of the CoreWeave Sandbox TypeScript SDK, committed so
the repo (and CI) can install it **without registry access or git credentials** for
the private upstream. Consumed by `@marimo-hub/compute-coreweave` via a
`file:../../vendor/cwsandbox` dependency.

Only the prebuilt output is committed:

- `dist/` — ESM bundles + `.d.ts` for the `.` and `/node` entrypoints. The `/wandb`
  entrypoint and all `*.map` files are pruned (we only use the direct CoreWeave API-key
  path, `@coreweave/cwsandbox/node`).
- `package.json` — trimmed to runtime fields only (`@grpc/grpc-js`, `@protobuf-ts/*`
  are public-npm, pure-JS, and install normally).
- `LICENSE-BSD-3-Clause.txt` — upstream license (BSD-3-Clause).

## Local patches

Re-apply after any vendor refresh (and retire once upstream exposes the option):

- **`serviceAddress` on `GetSandboxResult`** — upstream's `SandboxMetadata` type
  already declares `serviceAddress` (the runner-assigned external address of the
  sandbox's exposed service; the W&B gateway sets it to a per-sandbox public IP),
  and the generated proto carries it, but this pinned build's `get` mapper drops
  it. Patched (needed by `@marimo-hub/compute-coreweave`'s wandb URL resolver):
  - `dist/public/sandbox.d.ts` — `serviceAddress?` on `GetSandboxResult`.
  - `dist/chunk-*.js` (`GrpcSandboxTransport.get`) — pass
    `response.serviceAddress` through when non-empty.

- **`objectStorageAccess` on `SandboxRunOptions`** — upstream's generated proto
  already carries `StartSandboxRequest.object_storage_access` (Gateway mints a
  per-sandbox OIDC token; Runner injects a credential-vending sidecar with
  temporary S3 creds), but the public run options don't expose it. Patched:
  - `dist/public/sandbox.d.ts` — `SandboxObjectStorageAccess` type +
    `objectStorageAccess?` on `SandboxRunOptions`.
  - `dist/index.d.ts`, `dist/types.d.ts` — re-export `SandboxObjectStorageAccess`.
  - `dist/chunk-*.js` (`toProtoStartMetadata`) — map the option to the proto field
    (`permission`: `'read'` → 1, `'read-write'` → 2).

## Source

- Repo: `github.com/coreweave/cwsandbox-client-js`
- Pinned commit: `8fae6ddb2cbe112299595e9f836eb4662d3686e4`

## Refreshing

```bash
gh repo clone coreweave/cwsandbox-client-js /tmp/cwsandbox
( cd /tmp/cwsandbox && git checkout <new-sha> && pnpm install && pnpm build )

DST=vendor/cwsandbox
rm -rf "$DST/dist"
cp -R /tmp/cwsandbox/dist "$DST/dist"
rm -rf "$DST/dist/wandb"
find "$DST/dist" -name '*.map' -delete
cp /tmp/cwsandbox/LICENSE-BSD-3-Clause.txt "$DST/"
# Update the pinned commit above, then re-run `pnpm install` at the repo root.
```

The upstream build is `tsup && tsc` with all gRPC/protobuf stubs committed
(`src/node/generated/`), so no `buf` toolchain or codegen is needed to rebuild.
