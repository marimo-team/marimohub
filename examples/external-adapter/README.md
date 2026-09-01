# External adapter libraries

The Node server can load one external storage adapter and one external compute
adapter at startup. If marimohub does not include your provider, use this option.

Use a mounted ESM file:

```sh
MARIMOHUB_STORAGE_BACKEND=library \
MARIMOHUB_STORAGE_LIBRARY=../../examples/external-adapter/storage.mjs \
MARIMOHUB_COMPUTE_BACKEND=none \
MARIMOHUB_AUTH_BACKEND=dev \
pnpm --filter @marimo-hub/server exec vp run dev
```

Use an npm package installed in the server image:

```sh
MARIMOHUB_COMPUTE_BACKEND=library \
MARIMOHUB_COMPUTE_LIBRARY=@myorg/marimohub-compute \
MARIMOHUB_STORAGE_BACKEND=s3 \
MARIMOHUB_STORAGE_S3_BUCKET=my-hub \
MARIMOHUB_AUTH_BACKEND=oidc \
node apps/server/dist/index.mjs
```

For production, bundle the adapter and its SDK dependencies into one `.mjs` file.
Then mount the file in the server image. ESM does not use `NODE_PATH`.

Load only trusted modules. Each module runs in-process with server privileges.

`storage.mjs` is a non-durable, in-memory example. It does not implement
pagination or delimiter handling. This example is not for production. It creates
server-recognized precondition errors with `context.errors.preconditionFailed`.
A production adapter must implement the complete `Bucket` contract in
[`development_docs/ports.md`](../../development_docs/ports.md#external-adapter-libraries).

`compute.mjs` includes all required methods, but it rejects sandbox operations.
Replace its methods with calls to the provider SDK.

## OIDC login-policy module

The Node server can also load one trusted OIDC login-policy module. The module
runs after the built-in OIDC adapter validates the identity, and before the
adapter signs a session. It maps validated claims to a login decision and coarse
entitlements. It is not a runtime (per-request) authorization hook.

```sh
MARIMOHUB_AUTH_BACKEND=oidc \
MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND=library \
MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY=examples/external-adapter/oidc-login-policy.mjs \
node apps/server/dist/index.mjs
```

`oidc-login-policy.mjs` shows a compound AND rule across multiple claim paths.
Its attribute names and values are placeholders, not an authoritative access
policy.

`oidc-login-policy.test.mjs` shows how to test a policy module with nothing but
Node's built-in test runner — no framework install:

```sh
node --test examples/external-adapter/oidc-login-policy.test.mjs
```

Test your own module the same way before deploying it: import the bundled
`.mjs`, call `create()` once, and drive `evaluate()` with claim fixtures for
each allow and deny case.

Key facts:

- The built-in adapter completes all OIDC protocol validation. The module
  receives validated claims, but each claim _value_ remains untrusted
  provider data.
- The module is trusted in-process code with server privileges. Load only
  pinned, reviewed modules, and use the same artifact on every replica.
- The result affects browser login sessions only. Personal access tokens do not
  receive login-policy entitlements.
- The host never persists, logs, or writes raw claims into the session cookie.
  This guarantee covers the host only: the module itself sees every claim and
  runs with server privileges, so your policy code must not log or store claim
  values either.
- Login-policy configuration is mutually exclusive with the
  `MARIMOHUB_AUTH_OIDC_*GROUPS*` variables.
- A login decision expires with the session, after at most one hour. A module
  change requires a server restart and a new login.
