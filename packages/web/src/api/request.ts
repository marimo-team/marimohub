import { ApiRequestError } from './client';
import type { ApiRequestErrorCode } from './client';
import { withBasePath } from '../lib/basePath';

export const projectPath = (projectId: string) => withBasePath(`/api/v1/projects/${projectId}`);
export const notebookPath = (projectId: string, notebookId: string) =>
	`${projectPath(projectId)}/notebooks/${notebookId}`;

export function isApiErrorCode(err: unknown, code: ApiRequestErrorCode): boolean {
	return err instanceof ApiRequestError && err.code === code;
}

export const isNotFoundError = (err: unknown) => isApiErrorCode(err, 'NOT_FOUND');
