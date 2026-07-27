import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonOk } from '@/test/render';
import { ApiRequestError } from './client';
import {
	del,
	fetchItems,
	isApiErrorCode,
	isNotFoundError,
	notebookPath,
	patchJson,
	post,
	postJson,
	projectPath,
	putJson,
} from './request';

const PID = 'proj-1';
const NID = 'nb-1';

function stubFetch(data: unknown = { ok: true }) {
	const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => jsonOk(data));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

/** The last fetch call the request under test made, as (url, init). */
function lastCall(fetchMock: ReturnType<typeof stubFetch>) {
	const call = fetchMock.mock.calls.at(-1);
	if (!call) throw new Error('fetch was never called');
	const [url, init] = call;
	return { url: String(url), init };
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
	return new Headers(init?.headers).get(name);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('path builders', () => {
	it('composes the project and notebook roots', () => {
		expect(projectPath(PID)).toBe('/api/v1/projects/proj-1');
		expect(notebookPath(PID, NID)).toBe('/api/v1/projects/proj-1/notebooks/nb-1');
	});

	it('nests the notebook path under its project path', () => {
		expect(notebookPath(PID, NID).startsWith(`${projectPath(PID)}/`)).toBe(true);
	});
});

describe('JSON senders', () => {
	it.each([
		['postJson', postJson, 'POST'],
		['putJson', putJson, 'PUT'],
		['patchJson', patchJson, 'PATCH'],
	] as const)('%s sends %s with a JSON body', async (_name, send, method) => {
		const fetchMock = stubFetch();

		await send('/api/v1/thing', { a: 1, b: 'two' });

		const { url, init } = lastCall(fetchMock);
		expect(url).toBe('/api/v1/thing');
		expect(init?.method).toBe(method);
		expect(headerOf(init, 'content-type')).toBe('application/json');
		expect(String(init?.body)).toBe(JSON.stringify({ a: 1, b: 'two' }));
	});

	it('postJson with no body sends an empty JSON object', async () => {
		const fetchMock = stubFetch();

		await postJson('/api/v1/thing');

		expect(String(lastCall(fetchMock).init?.body)).toBe('{}');
	});

	it('forwards an init without clobbering the Content-Type header', async () => {
		const fetchMock = stubFetch();

		await postJson('/api/v1/thing', { a: 1 }, { timeout: 99_000 });

		const { init } = lastCall(fetchMock);
		expect(headerOf(init, 'content-type')).toBe('application/json');
		// The timeout is applied as an abort signal by the underlying client.
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.signal?.aborted).toBe(false);
	});

	it('lets an init add headers alongside the JSON content type', async () => {
		const fetchMock = stubFetch();

		await postJson('/api/v1/thing', { a: 1 }, { headers: { 'X-Trace': 'abc' } });

		const { init } = lastCall(fetchMock);
		expect(headerOf(init, 'content-type')).toBe('application/json');
		expect(headerOf(init, 'x-trace')).toBe('abc');
	});

	it('unwraps the response envelope to the typed data', async () => {
		stubFetch({ id: 'x' });

		await expect(postJson<{ id: string }>('/api/v1/thing')).resolves.toEqual({ id: 'x' });
	});
});

describe('bodyless verbs', () => {
	it('post sends POST with no body at all', async () => {
		const fetchMock = stubFetch();

		await post('/api/v1/thing');

		const { init } = lastCall(fetchMock);
		expect(init?.method).toBe('POST');
		expect(init?.body ?? undefined).toBeUndefined();
	});

	it('post forwards an init and still sends no body', async () => {
		const fetchMock = stubFetch();

		await post('/api/v1/thing', { timeout: 99_000 });

		const { init } = lastCall(fetchMock);
		expect(init?.method).toBe('POST');
		expect(init?.body ?? undefined).toBeUndefined();
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it('del sends DELETE with no body', async () => {
		const fetchMock = stubFetch(null);

		await del('/api/v1/thing/1');

		const { url, init } = lastCall(fetchMock);
		expect(url).toBe('/api/v1/thing/1');
		expect(init?.method).toBe('DELETE');
		expect(init?.body ?? undefined).toBeUndefined();
	});
});

describe('fetchItems', () => {
	it('unwraps the paginated envelope to just the items', async () => {
		stubFetch({ items: [{ id: 'a' }, { id: 'b' }], next_cursor: 'cur-1' });

		await expect(fetchItems<{ id: string }>('/api/v1/things')).resolves.toEqual([
			{ id: 'a' },
			{ id: 'b' },
		]);
	});

	it('returns an empty list for an empty page', async () => {
		stubFetch({ items: [], next_cursor: null });

		await expect(fetchItems('/api/v1/things')).resolves.toEqual([]);
	});
});

describe('error predicates', () => {
	it('matches an ApiRequestError by code', () => {
		expect(isApiErrorCode(new ApiRequestError('NOT_FOUND', 'gone'), 'NOT_FOUND')).toBe(true);
	});

	it('rejects a different code', () => {
		expect(isApiErrorCode(new ApiRequestError('FORBIDDEN', 'nope'), 'NOT_FOUND')).toBe(false);
	});

	it('rejects a plain Error and a non-error value', () => {
		expect(isApiErrorCode(new Error('NOT_FOUND'), 'NOT_FOUND')).toBe(false);
		expect(isApiErrorCode({ code: 'NOT_FOUND' }, 'NOT_FOUND')).toBe(false);
		expect(isApiErrorCode(undefined, 'NOT_FOUND')).toBe(false);
		expect(isApiErrorCode('NOT_FOUND', 'NOT_FOUND')).toBe(false);
	});

	it('isNotFoundError is isApiErrorCode pinned to NOT_FOUND', () => {
		expect(isNotFoundError(new ApiRequestError('NOT_FOUND', 'gone'))).toBe(true);
		expect(isNotFoundError(new ApiRequestError('INTERNAL_ERROR', 'boom'))).toBe(false);
		expect(isNotFoundError(new Error('gone'))).toBe(false);
		expect(isNotFoundError(null)).toBe(false);
	});
});

describe('header merging', () => {
	it('keeps headers given as a Headers instance', async () => {
		const fetchMock = stubFetch();

		await postJson('/api/v1/thing', { a: 1 }, { headers: new Headers({ 'X-Trace': 'abc' }) });

		const { init } = lastCall(fetchMock);
		expect(headerOf(init, 'content-type')).toBe('application/json');
		expect(headerOf(init, 'x-trace')).toBe('abc');
	});

	it('keeps headers given as an entry array', async () => {
		const fetchMock = stubFetch();

		await postJson('/api/v1/thing', { a: 1 }, { headers: [['X-Trace', 'abc']] });

		const { init } = lastCall(fetchMock);
		expect(headerOf(init, 'content-type')).toBe('application/json');
		expect(headerOf(init, 'x-trace')).toBe('abc');
	});

	it('wins over a caller-supplied content type — the body is always JSON', async () => {
		const fetchMock = stubFetch();

		await postJson('/api/v1/thing', { a: 1 }, { headers: { 'content-type': 'text/plain' } });

		expect(headerOf(lastCall(fetchMock).init, 'content-type')).toBe('application/json');
	});
});
