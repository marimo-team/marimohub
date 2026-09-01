import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './client';
import {
	isApiErrorCode,
	isNotFoundError,
	notebookPath,
	projectPath,
	workspaceArchivePath,
} from './request';

const PID = 'proj-1';
const NID = 'nb-1';

describe('raw path builders', () => {
	it('composes the project and notebook roots', () => {
		expect(projectPath(PID)).toBe('/api/v1/projects/proj-1');
		expect(notebookPath(PID, NID)).toBe('/api/v1/projects/proj-1/notebooks/nb-1');
		expect(workspaceArchivePath(PID, NID)).toBe(
			'/api/v1/projects/proj-1/notebooks/nb-1/workspace.zip',
		);
	});

	it('encodes path segments', () => {
		expect(notebookPath('project/one', 'notebook/two')).toBe(
			'/api/v1/projects/project%2Fone/notebooks/notebook%2Ftwo',
		);
	});
});

describe('error predicates', () => {
	it('matches an ApiRequestError by code', () => {
		expect(isApiErrorCode(new ApiRequestError('NOT_FOUND', 'gone'), 'NOT_FOUND')).toBe(true);
		expect(isApiErrorCode(new ApiRequestError('FORBIDDEN', 'nope'), 'NOT_FOUND')).toBe(false);
	});

	it('rejects values outside the API error class', () => {
		expect(isApiErrorCode(new Error('NOT_FOUND'), 'NOT_FOUND')).toBe(false);
		expect(isApiErrorCode({ code: 'NOT_FOUND' }, 'NOT_FOUND')).toBe(false);
		expect(isApiErrorCode(undefined, 'NOT_FOUND')).toBe(false);
	});

	it('identifies not-found API errors', () => {
		expect(isNotFoundError(new ApiRequestError('NOT_FOUND', 'gone'))).toBe(true);
		expect(isNotFoundError(new ApiRequestError('INTERNAL_ERROR', 'boom'))).toBe(false);
	});
});
