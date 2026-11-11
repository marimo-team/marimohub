import type { Bucket } from '../../ports/bucket';
import { paths } from '../../paths';
import type { SessionService } from '../runtime/SessionService';
import { bucketMigration } from './bucketMigration';
import { NotInitializedError } from '../../errors';
import type { ProjectService } from '../content/ProjectService';
import type { BackgroundMigration } from './MigrationService';

export const SESSION_INDEX_MIGRATION = 'session-index-v1';

export function backgroundMigrations(
	bucket: Bucket,
	projects: ProjectService,
	sessions: SessionService,
): readonly BackgroundMigration[] {
	return [
		{
			id: 'project-access-v1',
			runBatch: async (context) => {
				try {
					return await projects.migrateAccessSummaries(context);
				} catch (error) {
					// Initialization belongs to the first authorized request, not background work.
					if (error instanceof NotInitializedError) return { done: false, cursor: context.cursor };
					throw error;
				}
			},
		},
		bucketMigration({
			id: SESSION_INDEX_MIGRATION,
			bucket,
			prefix: paths.sessionsPrefix,
			migrate: (key, signal) => sessions.migrateSessionIndexEntry(key, signal),
		}),
	];
}
