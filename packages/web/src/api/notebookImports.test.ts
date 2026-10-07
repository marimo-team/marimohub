import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonOk } from '@/test/render';
import { notebookImports } from './notebookImports';

const IMPORT_ID = 'imp-0123456789abcdef';

function stubFetch(response: () => Response = () => jsonOk({})) {
	const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
		init?.signal?.throwIfAborted();
		return response();
	});
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

function request(fetch: ReturnType<typeof stubFetch>, index = 0) {
	const [input, init] = fetch.mock.calls[index];
	return { url: String(input), init: init! };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('notebookImports', () => {
	it('uploads the folder as a zip body with a long timeout', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		const prepared = { id: IMPORT_ID, expires_at: '2026-10-08T00:00:00.000Z', files: [] };
		const fetch = stubFetch(() => jsonOk(prepared, { status: 201 }));
		const bytes = new Uint8Array([80, 75, 3, 4, 0, 255]);

		await expect(notebookImports.prepare('proj-one', bytes)).resolves.toEqual(prepared);

		const { url, init } = request(fetch);
		expect(init.method).toBe('POST');
		expect(url).toMatch(/\/api\/v1\/projects\/proj-one\/notebook-imports$/);
		expect(new Headers(init.headers).get('content-type')).toBe('application/zip');
		expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
		expect(timeout).toHaveBeenCalledWith(300_000);
	});

	it('propagates an abort to the upload', async () => {
		const fetch = stubFetch();
		const controller = new AbortController();
		controller.abort();

		await expect(
			notebookImports.prepare('proj-one', new Uint8Array([1]), controller.signal),
		).rejects.toThrow();
		expect(request(fetch).init.signal?.aborted).toBe(true);
	});

	it('publishes one entry notebook as JSON', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		const fetch = stubFetch(() => jsonOk({ id: 'nb-1' }, { status: 201 }));
		const body = { entry_notebook: 'a/revenue.py', title: 'Revenue', base_image: 'python:3.13' };

		await notebookImports.publish('proj-one', IMPORT_ID, body);

		const { url, init } = request(fetch);
		expect(init.method).toBe('POST');
		expect(url).toMatch(
			new RegExp(`/api/v1/projects/proj-one/notebook-imports/${IMPORT_ID}/notebooks$`),
		);
		expect(JSON.parse(init.body as string)).toEqual(body);
		expect(timeout).toHaveBeenCalledWith(120_000);
	});

	it('reads every notebook outcome from the import', async () => {
		const outcome = {
			id: IMPORT_ID,
			expires_at: '2026-10-08T00:00:00.000Z',
			notebooks: [{ entry_notebook: 'a/revenue.py', state: 'preparing' }],
		};
		const fetch = stubFetch(() => jsonOk(outcome));

		await expect(notebookImports.get('proj-one', IMPORT_ID)).resolves.toEqual(outcome);

		const { url, init } = request(fetch);
		expect(init.method).toBe('GET');
		expect(url).toMatch(new RegExp(`/api/v1/projects/proj-one/notebook-imports/${IMPORT_ID}$`));
	});
});
