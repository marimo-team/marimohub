import { ApiRequestError } from './client';
import type { ApiRequestErrorCode } from './client';
import { withBasePath } from '../lib/basePath';

export const projectPath = (projectId: string) =>
	withBasePath(`/api/v1/projects/${encodeURIComponent(projectId)}`);
export const notebookPath = (projectId: string, notebookId: string) =>
	`${projectPath(projectId)}/notebooks/${encodeURIComponent(notebookId)}`;
export const workspaceArchivePath = (projectId: string, notebookId: string) =>
	`${notebookPath(projectId, notebookId)}/workspace.zip`;

export function isApiErrorCode(err: unknown, code: ApiRequestErrorCode): boolean {
	return err instanceof ApiRequestError && err.code === code;
}

export const isNotFoundError = (err: unknown) => isApiErrorCode(err, 'NOT_FOUND');
