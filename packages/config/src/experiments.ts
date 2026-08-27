import type { Env } from './env';

// Empty since `duckdb-wasm-preview` graduated to always-on; setting a graduated
// ID now logs the unknown-experiment warning as an upgrade nudge.
export const EXPERIMENTS = {} as const satisfies Record<string, { description: string }>;

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
