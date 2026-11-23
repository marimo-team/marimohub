import type { JobRunService } from '../jobs/JobRunService';
import type { Bucket } from '../../ports/bucket';
import { paths } from '../../paths';
import type { SessionService } from '../runtime/SessionService';
import { bucketMigration } from './bucketMigration';
import { NotInitializedError } from '../../errors';
import type { ProjectService } from '../content/ProjectService';
import type { MigrationDescriptor } from './migrationInspection';
import type { BackgroundMigration } from './MigrationService';

export const SESSION_INDEX_MIGRATION = 'session-index-v1';

export function backgroundMigrations(
	bucket: Bucket,
	projects: ProjectService,
	sessions: SessionService,
	jobRuns: JobRunService,
): readonly BackgroundMigration[] {
	return [
		{
			id: 'project-access-v1',
			title: 'Speed up project access checks',
			description: 'Build project access summaries in bounded batches.',
			impact:
				'The app stays available. Access checks use existing metadata until summaries are ready.',
			progressUnit: 'projects',
			runBatch: async (context) => {
				try {
					return await projects.migrateAccessSummaries(context);
				} catch (error) {
					// Initialization belongs to the first authorized request, not background work.
					if (error instanceof NotInitializedError)
						return {
							done: false,
							cursor: context.cursor,
							waiting_reason: 'waiting_for_initialization',
						};
					throw error;
				}
			},
		},
		{
			...bucketMigration({
				id: SESSION_INDEX_MIGRATION,
				bucket,
				prefix: paths.sessionsPrefix,
				migrate: (key, signal) => sessions.migrateSessionIndexEntry(key, signal),
			}),
			title: 'Index sessions by user',
			description: 'Build per-user session indexes.',
			impact: 'The app stays available. Session reads use existing scans until the index is ready.',
			progressUnit: 'sessions',
			after: [],
		},
		{
			...bucketMigration({
				id: 'project-run-index-v1',
				batchSize: 500,
				bucket,
				prefix: 'projects/',
				migrate: (key, signal) => jobRuns.migrateProjectRunIndexEntry(key, signal),
			}),
			title: 'Index project run history',
			description: 'Build project run locators in bounded batches.',
			impact: 'Existing job history remains available while project history is populated.',
			progressUnit: 'objects',
			after: [],
		},
	];
}

export const retiredMigrations: readonly MigrationDescriptor[] = [];
