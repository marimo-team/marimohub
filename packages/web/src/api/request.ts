import { apiFetch, ApiRequestError } from './client';

export const projectPath = (projectId: string) => `/api/v1/projects/${projectId}`;
export const notebookPath = (projectId: string, notebookId: string) =>
	`${projectPath(projectId)}/notebooks/${notebookId}`;

/** A page of a list endpoint: items plus an opaque cursor for the next page. */
export interface Paginated<T> {
	items: T[];
	next_cursor: string | null;
}

export async function fetchItems<T>(path: string): Promise<T[]> {
	return (await apiFetch<Paginated<T>>(path)).items;
}

type RequestOptions = RequestInit & { timeout?: number };

function sendJson<T>(method: string, path: string, body?: unknown, init?: RequestOptions) {
	// Merged through `Headers`, not object spread: `HeadersInit` is also allowed to
	// be a `Headers` or an entry array, and spreading either drops the caller's
	// headers (or invents numeric ones).
	const headers = new Headers(init?.headers);
	headers.set('Content-Type', 'application/json');
	return apiFetch<T>(path, { ...init, method, headers, body: JSON.stringify(body ?? {}) });
}

export const postJson = <T>(path: string, body?: unknown, init?: RequestOptions) =>
	sendJson<T>('POST', path, body, init);
export const putJson = <T>(path: string, body?: unknown) => sendJson<T>('PUT', path, body);
export const patchJson = <T>(path: string, body?: unknown) => sendJson<T>('PATCH', path, body);

/** POST with no body at all — distinct from `postJson(path)`, which sends `{}`. */
export const post = <T>(path: string, init?: RequestOptions) =>
	apiFetch<T>(path, { ...init, method: 'POST' });

export const del = <T = void>(path: string, init?: RequestOptions) =>
	apiFetch<T>(path, { ...init, method: 'DELETE' });

export function isApiErrorCode(err: unknown, code: string): boolean {
	return err instanceof ApiRequestError && err.code === code;
}

export const isNotFoundError = (err: unknown) => isApiErrorCode(err, 'NOT_FOUND');
