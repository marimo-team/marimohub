import type { Env } from './env';

export const EXPERIMENTS = {
	'duckdb-wasm-preview': {
		description: 'Run compatible integration-authored preview SQL in DuckDB-Wasm',
	},
	'duckdb-wasm-sql': {
		description:
			'Run bounded SQL against compatible integrations in an isolated DuckDB-Wasm worker',
	},
} as const;

export type Experiment = keyof typeof EXPERIMENTS;

export function parseExperiments(env: Env): ReadonlySet<Experiment> {
	const enabled = new Set<Experiment>();
	const known = Object.keys(EXPERIMENTS);
	for (const raw of env.MARIMOHUB_EXPERIMENTS?.split(',') ?? []) {
		const id = raw.trim().toLowerCase();
		if (!id) continue;
		if (!Object.hasOwn(EXPERIMENTS, id)) {
			console.warn(
				JSON.stringify({
					ts: new Date().toISOString(),
					event: 'experiment_unknown',
					id,
					known,
				}),
			);
			continue;
		}
		enabled.add(id as Experiment);
	}
	return enabled;
}
