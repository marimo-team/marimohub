import type { Env } from './env';
import { ConfigError } from './errors';

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
	for (const raw of env.MARIMOHUB_EXPERIMENTS?.split(',') ?? []) {
		const id = raw.trim().toLowerCase();
		if (!id) continue;
		if (!Object.hasOwn(EXPERIMENTS, id)) {
			throw new ConfigError(`Unknown MARIMOHUB_EXPERIMENTS value: ${id}.`, {
				variable: 'MARIMOHUB_EXPERIMENTS',
				remediation: `Use one or more of: ${Object.keys(EXPERIMENTS).join(', ')}.`,
			});
		}
		enabled.add(id as Experiment);
	}
	return enabled;
}
