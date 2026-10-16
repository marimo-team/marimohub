import { markSourceControlPublishFailure } from '@marimo-hub/core/ports/source-control';
import type { SourceControlPublishStage } from '@marimo-hub/core/ports/source-control';

export function createPublishStage(provider: string) {
	return async <T>(stage: SourceControlPublishStage, action: () => Promise<T>): Promise<T> => {
		try {
			return await action();
		} catch (error) {
			const status = (error as { providerStatus?: unknown } | null)?.providerStatus;
			throw markSourceControlPublishFailure(error, {
				provider,
				stage,
				status: typeof status === 'number' ? status : undefined,
			});
		}
	};
}
