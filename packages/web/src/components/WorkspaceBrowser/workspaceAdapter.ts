import { FinderError, readOnlyAdapter } from '@marimo-team/react-finder';
import type { WorkspaceItem, WorkspaceOperation } from '@marimo-hub/client';
import type {
	FileItem,
	FileSystemAdapter,
	ListResult,
	RequestOptions,
	SearchOptions,
} from '@marimo-team/react-finder';
import { apiClient, apiData, apiErrorFromResponse, ApiRequestError } from '@/api/client';
import { notebookPath } from '@/api/request';
import { isWorkspacePathProtected } from './workspacePolicy';
import type { WorkspaceAccess } from './workspacePolicy';

export type { WorkspaceAccess } from './workspacePolicy';

export function workspaceItemFromApi(item: WorkspaceItem): FileItem {
	return {
		path: item.path,
		name: item.name,
		kind: item.kind,
		...(item.size === undefined ? {} : { size: item.size }),
		...(item.modified_at === undefined ? {} : { modifiedAt: item.modified_at }),
		...(item.mime_type === undefined ? {} : { mimeType: item.mime_type }),
	};
}

function finderErrorForStatus(
	status: number | undefined,
	message: string,
	path?: string,
): FinderError {
	const code =
		status === 404
			? 'not_found'
			: status === 403
				? 'permission'
				: status === 409 || status === 412
					? 'exists'
					: 'unknown';
	return new FinderError(code, message, path ? { path } : undefined);
}

async function finderError(response: Response, path?: string): Promise<FinderError> {
	const error = await apiErrorFromResponse(
		response,
		response.statusText || 'Workspace request failed',
	);
	return finderErrorForStatus(response.status, error.message, path);
}

async function finderData<T>(request: Promise<T>, path?: string): Promise<T> {
	try {
		return await request;
	} catch (error) {
		if (error instanceof ApiRequestError) {
			throw finderErrorForStatus(error.status, error.message, path);
		}
		throw error;
	}
}

function query(path: string, extra: Record<string, string | undefined> = {}): string {
	const params = new URLSearchParams({ path });
	for (const [key, value] of Object.entries(extra)) {
		if (value !== undefined) params.set(key, value);
	}
	return params.toString();
}

async function workspaceItemResponse(response: Response, path: string): Promise<FileItem> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new FinderError('unknown', 'Workspace returned an invalid response', { path });
	}
	if (
		typeof body !== 'object' ||
		body === null ||
		!('success' in body) ||
		body.success !== true ||
		!('data' in body) ||
		typeof body.data !== 'object' ||
		body.data === null
	) {
		throw new FinderError('unknown', 'Workspace returned an invalid response', { path });
	}
	const item = body.data as Partial<WorkspaceItem>;
	if (
		typeof item.path !== 'string' ||
		typeof item.name !== 'string' ||
		(item.kind !== 'file' && item.kind !== 'directory')
	) {
		throw new FinderError('unknown', 'Workspace returned an invalid response', { path });
	}
	return workspaceItemFromApi(item as WorkspaceItem);
}

export async function fetchWorkspaceAccess(
	projectId: string,
	notebookId: string,
	signal?: AbortSignal,
): Promise<WorkspaceAccess> {
	return apiData(
		apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/workspace/access', {
			params: { path: { pid: projectId, nid: notebookId } },
			signal,
		}),
	);
}

export class WorkspaceAdapter implements FileSystemAdapter {
	private readonly base: string;
	private readonly ids: { pid: string; nid: string };

	constructor(
		projectId: string,
		notebookId: string,
		private readonly access: WorkspaceAccess,
	) {
		this.base = `${notebookPath(projectId, notebookId)}/workspace`;
		this.ids = { pid: projectId, nid: notebookId };
	}

	async list(
		path: string,
		opts: { signal?: AbortSignal; cursor?: string } = {},
	): Promise<ListResult> {
		const result = await finderData(
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/workspace/entries', {
					params: {
						path: this.ids,
						query: { path, cursor: opts.cursor },
					},
					signal: opts.signal,
				}),
			),
			path,
		);
		return {
			items: result.items.map(workspaceItemFromApi),
			...(result.cursor ? { cursor: result.cursor } : {}),
		};
	}

	async createFile(
		path: string,
		opts: { signal?: AbortSignal; content?: Blob | string } = {},
	): Promise<FileItem> {
		this.assertAllowed('create', path);
		return this.put(path, opts.content ?? '', opts.signal, true);
	}

	async createDirectory(path: string, opts: RequestOptions = {}): Promise<FileItem> {
		this.assertAllowed('create', path);
		return workspaceItemFromApi(
			await finderData(
				apiData(
					apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/workspace/directories', {
						params: { path: this.ids },
						body: { path },
						signal: opts.signal,
					}),
				),
				path,
			),
		);
	}

	async delete(path: string, opts: RequestOptions = {}): Promise<void> {
		this.assertAllowed('delete', path);
		await finderData(
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}/notebooks/{nid}/workspace/entries', {
					params: { path: this.ids, query: { path } },
					signal: opts.signal,
				}),
			),
			path,
		);
	}

	async move(from: string, to: string, opts: RequestOptions = {}): Promise<FileItem> {
		this.assertAllowed('move', from);
		this.assertAllowed('move', to);
		return this.transfer('move', from, to, opts.signal);
	}

	async copy(from: string, to: string, opts: RequestOptions = {}): Promise<FileItem> {
		this.assertAllowed('copy', from);
		return this.transfer('copy', from, to, opts.signal);
	}

	async readFile(path: string, opts: RequestOptions = {}): Promise<Blob> {
		const response = await fetch(`${this.base}/files?${query(path)}`, { signal: opts.signal });
		if (!response.ok) throw await finderError(response, path);
		return response.blob();
	}

	async writeFile(
		path: string,
		content: Blob | string,
		opts: RequestOptions = {},
	): Promise<FileItem> {
		this.assertAllowed('write', path);
		return this.put(path, content, opts.signal, false);
	}

	async getDownloadUrl(path: string): Promise<string> {
		return `${this.base}/files?${query(path)}`;
	}

	async search(queryValue: string, opts: SearchOptions = {}): Promise<FileItem[]> {
		const result = await finderData(
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/workspace/search', {
					params: {
						path: this.ids,
						query: { path: opts.path ?? '/', query: queryValue },
					},
					signal: opts.signal,
				}),
			),
		);
		return result.items.map(workspaceItemFromApi);
	}

	private assertAllowed(operation: WorkspaceOperation, path: string): void {
		if (isWorkspacePathProtected(this.access, path, operation)) {
			throw new FinderError('permission', `${path} cannot be moved or deleted`, { path });
		}
	}

	private async put(
		path: string,
		content: Blob | string,
		signal: AbortSignal | undefined,
		create: boolean,
	): Promise<FileItem> {
		const response = await fetch(
			`${this.base}/files?${query(path, create ? { create: 'true' } : {})}`,
			{ method: 'PUT', body: content, signal },
		);
		if (!response.ok) throw await finderError(response, path);
		return workspaceItemResponse(response, path);
	}

	private async transfer(
		action: 'move' | 'copy',
		from: string,
		to: string,
		signal?: AbortSignal,
	): Promise<FileItem> {
		const result = await finderData(
			apiData(
				action === 'move'
					? apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/workspace/move', {
							params: { path: this.ids },
							body: { from, to },
							signal,
						})
					: apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/workspace/copy', {
							params: { path: this.ids },
							body: { from, to },
							signal,
						}),
			),
			from,
		);
		return workspaceItemFromApi(result);
	}
}

export function workspaceAdapter(
	projectId: string,
	notebookId: string,
	access: WorkspaceAccess,
): FileSystemAdapter {
	const adapter = new WorkspaceAdapter(projectId, notebookId, access);
	return access.writable ? adapter : readOnlyAdapter(adapter);
}
