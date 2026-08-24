import { describe, expect, it } from 'vitest';
import { MAX_WORKSPACE_FILE_BYTES } from '../constants';
import { BadRequestError } from '../errors';
import {
	GitDirectoryLimitTracker,
	markSourceControlPublishFailure,
	MAX_GIT_DIRECTORY_BYTES,
	MAX_GIT_DIRECTORY_FILES,
	sourceControlPublishFailure,
} from './sourceControl';

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
describe('GitDirectoryLimitTracker', () => {
	it('accepts the exact file-count and cumulative-byte boundaries', () => {
		const limits = new GitDirectoryLimitTracker();
		const entryBytes = Math.floor(MAX_GIT_DIRECTORY_BYTES / MAX_GIT_DIRECTORY_FILES);
		for (let index = 0; index < MAX_GIT_DIRECTORY_FILES - 1; index++) {
			limits.add(`objects/${index}`, entryBytes);
		}
		limits.add(
			'objects/final',
			MAX_GIT_DIRECTORY_BYTES - entryBytes * (MAX_GIT_DIRECTORY_FILES - 1),
		);
	});

	it('rejects an entry beyond the file-count cap', () => {
		const limits = new GitDirectoryLimitTracker();
		for (let index = 0; index < MAX_GIT_DIRECTORY_FILES; index++) {
			limits.add(`objects/${index}`, 0);
		}
		expect(() => limits.add('objects/overflow', 0)).toThrow(
			`${MAX_GIT_DIRECTORY_FILES}-file limit`,
		);
	});

	it('rejects cumulative materialized bytes beyond the cap', () => {
		const limits = new GitDirectoryLimitTracker();
		const part = Math.floor(MAX_GIT_DIRECTORY_BYTES / 5) + 1;
		for (let index = 0; index < 4; index++) limits.add(`objects/${index}`, part);
		expect(() => limits.add('objects/overflow', part)).toThrow(
			`${MAX_GIT_DIRECTORY_BYTES}-byte limit`,
		);
	});

	it.each([MAX_WORKSPACE_FILE_BYTES + 1, -1, Number.NaN])(
		'rejects an invalid individual entry size: %s',
		(size) => {
			const limits = new GitDirectoryLimitTracker();
			expect(() => limits.add('objects/invalid', size)).toThrow(BadRequestError);
		},
	);
});
