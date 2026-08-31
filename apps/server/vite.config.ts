import { defineConfig } from 'vite-plus';
import { DUCKDB_EXTENSION_MANIFEST } from '../../packages/duckdb-wasm-runtime/src/extensionManifest';

// Bundle the Node server into a self-contained dist/index.mjs. Workspace packages
// are source-only (their exports point at src/*.ts), so they MUST be bundled;
// the npm runtime deps are bundled too so the runtime image needs no node_modules.
export default defineConfig({
	// Cached build task: `output` archives/restores dist/ on a hit (a script can't).
	run: {
		tasks: {
			dev: {
				command: 'tsx watch --env-file-if-exists=.env src/dev.ts',
				untrackedEnv: ['PORT', 'MARIMOHUB_*', 'OTEL_*'],
			},
			build: { command: 'vp pack', output: ['dist/**'] },
		},
	},
	pack: {
		entry: ['src/index.ts', 'src/duckdbWorker.ts', 'src/postgresWorker.ts'],
		platform: 'node',
		format: ['esm'],
		dts: false,
		noExternal: [
			/^@marimo-hub\//,
			/^hono/,
			/^@hono\//,
			/^jose$/,
			/^oauth4webapi$/,
			// ofetch + its (pure-JS) deps must be bundled — the runtime image ships
			// no node_modules, so externalizing them crashes adapters that use it.
			/^ofetch$/,
			/^node-fetch-native$/,
			/^destr$/,
			/^ufo$/,
			/^ulidx$/,
			// Match subpath imports too (zod/v3, zod/v4) — the ai SDK imports them.
			/^zod(\/|$)/,
			/^nodemailer$/,
			// better-all (pure-JS, used by core's provisioning graph) must be
			// bundled — the runtime image ships no node_modules.
			/^better-all$/,
			// fflate (pure-JS zip, used by the workspace-download route) must be
			// bundled — the runtime image ships no node_modules.
			/^fflate$/,
			// OpenTelemetry (pure-JS + node built-ins) must be bundled — the runtime
			// image ships no node_modules.
			/^@opentelemetry\//,
			/^@aws-sdk\//,
			/^@azure\//,
			// The CoreWeave Sandbox SDK and its (pure-JS) gRPC/protobuf
			// deps must be bundled too — the runtime image ships no node_modules,
			// so externalizing them crashes the `coreweave` compute backend at
			// boot with ERR_MODULE_NOT_FOUND '@coreweave/cwsandbox'.
			/^@coreweave\//,
			/^@grpc\//,
			/^@protobuf-ts\//,
		],
		copy: [
			{
				from: '../../packages/duckdb-wasm-runtime/node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm',
				to: 'dist',
			},
			...Object.values(DUCKDB_EXTENSION_MANIFEST).map(({ file }) => ({
				from: `../../packages/duckdb-wasm-runtime/assets/extensions/${file}`,
				to: 'dist',
			})),
		],
	},
});
