import { describe, expect, it, vi } from 'vitest';
import { ConflictError } from '@marimo-hub/core/errors';
import {
	markSourceControlPublishFailure,
	sourceControlPublishFailure,
} from '@marimo-hub/core/ports/source-control';
import { createPublishStage } from './publication';

describe('publication failure metadata', () => {
	it.each(['github', 'gitlab', 'azure-devops'])(
		'preserves HTTP status and the original error for %s',
		async (provider) => {
			const error = Object.assign(new ConflictError('Branch changed'), { providerStatus: 409 });
			const stage = createPublishStage(provider);
			await expect(
				stage('push', async () => {
					throw error;
				}),
			).rejects.toBe(error);
			expect(sourceControlPublishFailure(error)).toEqual({ provider, stage: 'push', status: 409 });
		},
	);
	it('keeps the inner failure stage and condition', async () => {
		const stage = createPublishStage('gitlab');
		const error = markSourceControlPublishFailure(new ConflictError('Branch changed'), {
			provider: 'gitlab',
			stage: 'branch',
			condition: 'branch_changed',
		});
		await expect(
			stage('pr', () =>
				stage('push', async () => {
					throw error;
				}),
			),
		).rejects.toBe(error);
		expect(sourceControlPublishFailure(error)).toEqual({
			provider: 'gitlab',
			stage: 'branch',
			condition: 'branch_changed',
		});
	});
	it.each([null, 'failure', { providerStatus: '503' }])(
		'annotates non-Error failures without inventing a status: %j',
		async (failure) => {
			const error = await createPublishStage('gitlab')(
				'pr',
				vi.fn().mockRejectedValue(failure),
			).catch((error: unknown) => error);
			expect(sourceControlPublishFailure(error)).toEqual({ provider: 'gitlab', stage: 'pr' });
		},
	);
});
