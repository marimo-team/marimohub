import { ApiRequestError } from './client';

export const projectPath = (projectId: string) => `/api/v1/projects/${projectId}`;
export const notebookPath = (projectId: string, notebookId: string) =>
	`${projectPath(projectId)}/notebooks/${notebookId}`;

export function isApiErrorCode(err: unknown, code: string): boolean {
	return err instanceof ApiRequestError && err.code === code;
}

export const isNotFoundError = (err: unknown) => isApiErrorCode(err, 'NOT_FOUND');
