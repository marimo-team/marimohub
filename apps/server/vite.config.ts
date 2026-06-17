import { defineConfig } from 'vite-plus';

// Bundle the Node server into a self-contained dist/index.mjs. Workspace packages
// are source-only (their exports point at src/*.ts), so they MUST be bundled;
// the npm runtime deps are bundled too so the runtime image needs no node_modules.
export default defineConfig({
	pack: {
		platform: 'node',
		format: ['esm'],
		dts: false,
		noExternal: [/^@marimo-hub\//, /^hono/, /^@hono\//, /^jose$/, /^ulidx$/, /^zod$/, /^@aws-sdk\//],
	},
});
