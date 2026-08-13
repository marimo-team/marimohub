import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, lazyPlugins } from 'vite-plus';

function envPort(value: string | undefined, fallback: number): number {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : fallback;
}

const apiPort = envPort(process.env.PORT, 3000);
const webPort = envPort(process.env.WEB_PORT, 5175);

// React SPA. The Cloudflare vite-plugin is intentionally absent — the SPA is a
// pure consumer of the /api/* surface and is served as static assets by whatever
// fronts the deployment (apps/server in Node, or Cloudflare in the reference).
export default defineConfig({
	// lazyPlugins: only loaded for dev/build/preview, not for `vp lint`/`vp fmt`.
	plugins: lazyPlugins(() => [react(), tailwindcss()]),
	resolve: {
		alias: {
			'@': path.resolve(fileURLToPath(new URL('.', import.meta.url)), './src'),
		},
	},
	server: {
		port: webPort,
		strictPort: true,
		open: true,
		// Proxy API calls to the local Node server (apps/server) so the SPA dev
		// server can reach the /api/* surface during development.
		proxy: {
			'/api': {
				target: `http://localhost:${apiPort}`,
				// Rewriting Host would make it differ from Origin and trip the CSRF guard.
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
			dev: {
				command: 'vp dev',
				untrackedEnv: ['PORT', 'WEB_PORT'],
			},
			build: { command: 'vp build', output: ['dist/**'] },
		},
	},
	// jsdom environment so component/hook tests can render; the pure-logic tests
	// (lib/*) run fine here too. `setup.ts` wires jest-dom matchers + auto-cleanup.
	test: {
		environment: 'jsdom',
		pool: 'threads',
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
