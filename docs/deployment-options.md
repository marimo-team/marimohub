# Deployment options

There are two ways to run MarimoHub. Both run the same server; they differ only
in how you select and wire your backends.

## 1. Config-driven (the common case)

Set `MARIMOHUB_*` environment variables and let the server select and wire
adapters for you. This is what `apps/server` (the Docker/Kubernetes image) does.

```ts
import { createFromEnv } from '@marimo-hub/config';
import { createApi } from '@marimo-hub/api';

const deps = createFromEnv(process.env); // reads MARIMOHUB_* + selects adapters
const app = createApi(deps);
```

- Pick a backend per port with the `*_BACKEND` selectors.
- Everything is documented in [Configuration](./configuration.md).
- Best for standard deployments (Docker, Kubernetes).

## 2. SDK / library composition (the complex case)

Import the adapters you want and construct `createApi(deps)` by hand. Use this
when you need a custom adapter, custom routes, or a non-standard runtime. See
[`examples/library-composition`](https://github.com/marimo-team/marimohub/tree/main/examples/library-composition).

```ts
import { createApi } from '@marimo-hub/api';
import { createServices } from '@marimo-hub/core';
import { S3Storage } from '@marimo-hub/storage-s3';
import { ModalCompute } from '@marimo-hub/compute-modal';

const bucket = new S3Storage({ bucket: 'my-bucket' /* … */ });
const app = createApi({
	services: createServices(bucket),
	bucket,
	compute: new ModalCompute({
		/* … */
	}),
	authenticator: new MyAuthenticator(),
	sandboxBucket: {
		name: 'my-bucket',
		endpoint: 'https://…',
		credentials: {
			/* … */
		},
	},
	sandboxHostname: 'hub.example.com',
});
```

::: tip Generate this for your backends
The configurator on [Getting started](/getting-started) has a **Library** tab
that emits this wiring for whatever storage / compute / auth you pick — copy it
instead of writing it by hand.
:::

- You own adapter selection and lifecycle.
- Required `ApiDeps`: `services`, `bucket`, `compute`, `authenticator`,
  `sandboxBucket`, `sandboxHostname`. Commonly set: `sandboxWorkdir`,
  `persistWorkspace`, `authRoutes`, `maxConcurrentSessionsPerUser`,
  `allowedOrigins`, `defaultRole`.
- The Cloudflare Workers entrypoint (`examples/cloudflare-worker`) is a library
  composition because R2 and Containers are platform bindings, not env credentials.

## Which one?

| Use config-driven if…       | Use the SDK if…                                 |
| --------------------------- | ----------------------------------------------- |
| Standard Docker/k8s deploy  | You need a custom storage/compute/auth adapter  |
| All adapters are built-in   | You're on a runtime with platform bindings (CF) |
| You want the prebuilt image | You want to add routes or embed in another app  |
