import path from 'node:path';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite-plus';

// React SPA. The Cloudflare vite-plugin is intentionally absent — the SPA is a
// pure consumer of the /api/* surface and is served as static assets by whatever
// fronts the deployment (apps/server in Node, or Cloudflare in the reference).
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
	server: {
		port: 5175,
		// Proxy API calls to the local Node server (apps/server) so the SPA dev
		// server can reach the /api/* surface during development.
		proxy: {
			'/api': {
				target: 'http://localhost:3000',
				changeOrigin: true,
			},
		},
	},
	build: {
		outDir: 'dist',
	},
});
