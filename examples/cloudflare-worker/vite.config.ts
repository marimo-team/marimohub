import { testTasks } from '@marimo-hub/vite-config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
	test: { include: ['src/**/*.test.ts'], pool: 'threads' },
	run: { tasks: testTasks },
});
