import type { ViteUserConfig } from 'vite-plus';
import { defineConfig } from 'vite-plus';

type Tasks = NonNullable<NonNullable<ViteUserConfig['run']>['tasks']>;

// Vitest writes its module cache (`node_modules/.vitest-cache`) and its results cache
// (`node_modules/.vite/vitest`) through `.tmp-*` files that it renames into place. Vite
// Task exempts the final paths from tracking but not the temporaries, so a run that
// happens to read and write one is refused from the task cache. Exclude both trees.
const vitestCacheGlobs = ['!node_modules/.vitest-cache/**', '!**/node_modules/.vite/vitest/**'].map(
	(pattern) => ({ pattern, base: 'workspace' as const }),
);

// Variables that opt tests in or out (live suites, integration interpreters, report and
// snapshot-update switches). Fingerprinting them keeps a run made without one from being
// replayed as a hit once it is set.
const testEnv = [
	'MARIMOHUB_*',
	'MARIMO_*',
	'MH_*',
	'APP_PERFORMANCE_REPORT',
	'SEARCH_BENCH',
	'UPDATE_*',
	'MODAL_*',
	'GOOGLE_APPLICATION_CREDENTIALS',
];

/** Cache settings for any task that runs Vitest; spread extra globs into `input`/`output`. */
export const vitestTaskCache = {
	env: testEnv,
	input: [{ auto: true }, ...vitestCacheGlobs],
	output: [{ auto: true }, ...vitestCacheGlobs],
};

// The `test` package.json script delegates to this task so the exclusions apply; a
// script and a task cannot share a name.
export const testTasks = {
	'test:vitest': { command: 'vp test', cache: vitestTaskCache },
} satisfies Tasks;

export function libraryConfig(overrides: ViteUserConfig = {}): ViteUserConfig {
	const { pack, test, run, ...rest } = overrides;
	return defineConfig({
		...rest,
		pack: Array.isArray(pack) ? pack : { dts: true, ...pack },
		test: { include: ['src/**/*.test.ts'], pool: 'threads', ...test },
		run: { ...run, tasks: { ...testTasks, ...run?.tasks } },
	});
}
