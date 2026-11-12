import type { ApiDeps } from '@marimo-hub/api';

export const MIGRATION_DEADLINE_MS = 55_000;

export async function runMigrationAttempt(deps: ApiDeps, signal: AbortSignal): Promise<boolean> {
	const deadline = new AbortController();
	const timer = setTimeout(
		() => deadline.abort(new DOMException('Migration deadline', 'TimeoutError')),
		MIGRATION_DEADLINE_MS,
	);
	try {
		return await deps.services.migrations.tick(AbortSignal.any([signal, deadline.signal]));
	} finally {
		clearTimeout(timer);
	}
}
