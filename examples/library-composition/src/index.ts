/**
 * Library-based composition (development_docs/architecture.md §5).
 *
 * When the MARIMOHUB_* config surface doesn't cover your case — a bespoke
 * storage backend, a custom Authenticator, embedding MarimoHub in a larger app —
 * import the packages and wire the adapters yourself. The ports (Bucket,
 * SandboxProvider, Authenticator) are the extension points.
 */
import { serve } from '@hono/node-server';
import { createApi } from '@marimo-hub/api';
import { createServices } from '@marimo-hub/core';
import { S3Storage } from '@marimo-hub/storage-s3';
import { ModalCompute } from '@marimo-hub/compute-modal';
import { DevAuthenticator } from '@marimo-hub/auth-dev';

const bucket = new S3Storage({
	bucket: process.env.S3_BUCKET ?? 'my-bucket',
	endpoint: process.env.S3_ENDPOINT,
	region: process.env.S3_REGION ?? 'auto',
	forcePathStyle: true,
	credentials: {
		accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
		secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
	},
});

const app = createApi({
	services: createServices(bucket),
	bucket,
	compute: new ModalCompute({
		tokenId: process.env.MODAL_TOKEN_ID ?? '',
		tokenSecret: process.env.MODAL_TOKEN_SECRET ?? '',
		image: process.env.MODAL_IMAGE ?? 'ghcr.io/orgname/marimohub-sandbox:latest',
	}),
	// Swap this for any custom `Authenticator` implementation.
	authenticator: new DevAuthenticator({ email: 'owner@example.com' }),
	sandbox: {
		bucket: {
			name: process.env.S3_BUCKET ?? 'my-bucket',
			endpoint: process.env.S3_ENDPOINT ?? '',
		},
		hostname: process.env.SANDBOX_HOSTNAME ?? 'localhost',
		workdir: process.env.MARIMOHUB_COMPUTE_WORKDIR ?? '/workspace',
		persistWorkspace: 'source',
	},
	policy: {},
});

serve({ fetch: app.fetch, port: 3000 }, (info) => {
	console.log(`listening on :${info.port}`);
});
