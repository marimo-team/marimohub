# External adapter libraries

The Node server can load one external storage adapter and one external compute
adapter at startup. If marimohub does not include your provider, use this option.

Use a mounted ESM file:

```sh
MARIMOHUB_STORAGE_BACKEND=library \
MARIMOHUB_STORAGE_LIBRARY=./examples/external-adapter/storage.mjs \
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
