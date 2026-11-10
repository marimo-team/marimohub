import { NotInitializedError } from '../../errors';
import type { ProjectService } from '../content/ProjectService';
import type { BackgroundMigration } from './MigrationService';

export function backgroundMigrations(projects: ProjectService): readonly BackgroundMigration[] {
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
	];
}
