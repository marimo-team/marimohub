import path from 'node:path';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, lazyPlugins } from 'vite-plus';

// React SPA. The Cloudflare vite-plugin is intentionally absent — the SPA is a
// pure consumer of the /api/* surface and is served as static assets by whatever
// fronts the deployment (apps/server in Node, or Cloudflare in the reference).
export default defineConfig({
	// lazyPlugins: only loaded for dev/build/preview, not for `vp lint`/`vp fmt`.
	plugins: lazyPlugins(() => [react(), tailwindcss()]),
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
	server: {
		port: 5175,
		open: true,
		// Proxy API calls to the local Node server (apps/server) so the SPA dev
		// server can reach the /api/* surface during development.
		proxy: {
			'/api': {
				target: 'http://localhost:3000',
				// Keep the browser's Host header (localhost:5175) instead of rewriting it
				// to the target. The API's CSRF guard rejects requests whose Origin host
				// differs from Host; with changeOrigin the proxied Host becomes
				// localhost:3000 while Origin stays localhost:5175, tripping the guard.
				changeOrigin: false,
			},
		},
	},
	build: {
		outDir: 'dist',
	},
	// Cached build task: `output` archives/restores dist/ on a hit (a script can't).
	run: {
		tasks: {
			build: { command: 'vp build', output: ['dist/**'] },
		},
	},
	// jsdom environment so component/hook tests can render; the pure-logic tests
	// (lib/*) run fine here too. `setup.ts` wires jest-dom matchers + auto-cleanup.
	test: {
		environment: 'jsdom',
		setupFiles: ['./src/test/setup.ts'],
		include: ['src/**/*.test.{ts,tsx}'],
		// The root config excludes this package from its coverage run (the `@/`
		// aliases only resolve under this config), so the settings live here.
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			include: ['src/**/*.{ts,tsx}'],
			exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/**/*.d.ts'],
		},
	},
});
