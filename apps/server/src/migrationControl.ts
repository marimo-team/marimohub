import type { ApiDeps } from '@marimo-hub/api';

export const MIGRATION_DEADLINE_MS = 55_000;

export function runMigrationAttempt(deps: ApiDeps, signal: AbortSignal): Promise<boolean> {
	return deps.services.migrations.tick(
		AbortSignal.any([signal, AbortSignal.timeout(MIGRATION_DEADLINE_MS)]),
	);
}
