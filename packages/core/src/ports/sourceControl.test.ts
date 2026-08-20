import { describe, expect, it } from 'vitest';
import { markSourceControlPublishFailure, sourceControlPublishFailure } from './sourceControl';

describe('source-control publish failures', () => {
	it('preserves a non-Error thrown value as the annotated error cause', () => {
		const thrown = 'connection reset';
		const error = markSourceControlPublishFailure(thrown, {
			provider: 'github',
			stage: 'push',
		});

		expect(error).toBeInstanceOf(Error);
		expect(error.cause).toBe(thrown);
		expect(sourceControlPublishFailure(error)).toEqual({
			provider: 'github',
			stage: 'push',
		});
	});

	it('preserves the provider metadata closest to the failure', () => {
		const error = markSourceControlPublishFailure(new Error('rejected'), {
			provider: 'github',
			stage: 'branch',
			condition: 'branch_changed',
		});

		markSourceControlPublishFailure(error, {
			provider: 'github',
			stage: 'pr',
		});

		expect(sourceControlPublishFailure(error)).toEqual({
			provider: 'github',
			stage: 'branch',
			condition: 'branch_changed',
		});
	});
});
