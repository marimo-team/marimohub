import { testTasks } from '@marimo-hub/vite-config';
import { defineConfig } from 'vite-plus';

// Tests live under .vitepress/, so the Vitest default include applies.
export default defineConfig({
	test: { pool: 'threads' },
	run: { tasks: testTasks },
});
