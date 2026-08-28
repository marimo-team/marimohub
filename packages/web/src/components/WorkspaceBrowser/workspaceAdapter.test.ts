import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinderError } from '@marimo-team/react-finder';
import {
	fetchWorkspaceAccess,
	WorkspaceAdapter,
	workspaceAdapter,
	workspaceItemFromApi,
} from './workspaceAdapter';
import type { WorkspaceAccess } from './workspaceAdapter';

const access: WorkspaceAccess = {
	writable: true,
	read_only_reason: null,
	protected_paths: [
		{ path: '/notebook.py', denied_operations: ['move', 'delete'] },
		{ path: '/pyproject.toml', denied_operations: ['move', 'delete'] },
	],
};

function jsonOk(data: unknown): Response {
	return new Response(JSON.stringify({ success: true, data }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('WorkspaceAdapter', () => {
	it('loads access metadata and maps API entries to finder items', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonOk(access))
			.mockResolvedValueOnce(
				jsonOk({
					items: [
						{
							path: '/assets/logo.png',
							name: 'logo.png',
							kind: 'file',
							size: 42,
							modified_at: 123,
							mime_type: 'image/png',
						},
					],
					cursor: 'next',
				}),
			);
		vi.stubGlobal('fetch', fetch);

		const resultAccess = await fetchWorkspaceAccess('project-1', 'notebook-1');
		const adapter = new WorkspaceAdapter('project-1', 'notebook-1', resultAccess);
		const result = await adapter.list('/assets');

		expect(result).toEqual({
			items: [
				{
					path: '/assets/logo.png',
					name: 'logo.png',
					kind: 'file',
					size: 42,
					modifiedAt: 123,
					mimeType: 'image/png',
				},
			],
			cursor: 'next',
		});
		expect(fetch).toHaveBeenLastCalledWith(
			'/api/v1/projects/project-1/notebooks/notebook-1/workspace/entries?path=%2Fassets',
			expect.objectContaining({ method: 'GET' }),
		);
	});

	it('omits absent optional item metadata', () => {
		expect(workspaceItemFromApi({ path: '/empty', name: 'empty', kind: 'directory' })).toEqual({
			path: '/empty',
			name: 'empty',
			kind: 'directory',
		});
	});

	it('rejects protected moves and deletes before making a request', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		const adapter = new WorkspaceAdapter('project-1', 'notebook-1', access);

		await expect(adapter.move?.('/notebook.py', '/renamed.py')).rejects.toMatchObject({
			code: 'permission',
		});
		await expect(adapter.delete?.('/pyproject.toml')).rejects.toBeInstanceOf(FinderError);
		await expect(adapter.move?.('/data.txt', '/pyproject.toml')).rejects.toMatchObject({
			code: 'permission',
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each(['git_source', 'viewer', 'active_session'] as const)(
		'hides every mutation for the %s read-only reason',
		(reason) => {
			const adapter = workspaceAdapter('project-1', 'notebook-1', {
				...access,
				writable: false,
				read_only_reason: reason,
			});

			expect(adapter.list).toBeTypeOf('function');
			expect(adapter.readFile).toBeTypeOf('function');
			expect(adapter.createFile).toBeUndefined();
			expect(adapter.createDirectory).toBeUndefined();
			expect(adapter.writeFile).toBeUndefined();
			expect(adapter.move).toBeUndefined();
			expect(adapter.copy).toBeUndefined();
			expect(adapter.delete).toBeUndefined();
		},
	);

	it('round-trips raw file content and maps API conflicts', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonOk({ path: '/data.bin', name: 'data.bin', kind: 'file', size: 3 }))
			.mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 2])))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: false, error: { message: 'destination exists' } }), {
					status: 409,
					headers: { 'content-type': 'application/json' },
				}),
			);
		vi.stubGlobal('fetch', fetch);
		const adapter = new WorkspaceAdapter('project-1', 'notebook-1', access);

		await expect(
			adapter.writeFile?.('/data.bin', new Uint8Array([0, 1, 2]) as never),
		).resolves.toEqual({ path: '/data.bin', name: 'data.bin', kind: 'file', size: 3 });
		await expect(adapter.readFile?.('/data.bin')).resolves.toBeInstanceOf(Blob);
		await expect(adapter.copy?.('/data.bin', '/copy.bin')).rejects.toMatchObject({
			code: 'exists',
			message: 'destination exists',
		});
	});

	it('maps directory, delete, transfer, and search requests through the typed client', async () => {
		const item = { path: '/data', name: 'data', kind: 'directory' };
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonOk(item))
			.mockResolvedValueOnce(jsonOk(undefined))
			.mockResolvedValueOnce(jsonOk({ ...item, path: '/moved', name: 'moved' }))
			.mockResolvedValueOnce(jsonOk({ ...item, path: '/copied', name: 'copied' }))
			.mockResolvedValueOnce(jsonOk({ items: [{ ...item, path: '/data/a.txt', name: 'a.txt' }] }));
		vi.stubGlobal('fetch', fetch);
		const adapter = new WorkspaceAdapter('project-1', 'notebook-1', access);

		await expect(adapter.createDirectory?.('/data')).resolves.toMatchObject(item);
		await expect(adapter.delete?.('/data/old.txt')).resolves.toBeUndefined();
		await expect(adapter.move?.('/data', '/moved')).resolves.toMatchObject({ path: '/moved' });
		await expect(adapter.copy?.('/moved', '/copied')).resolves.toMatchObject({ path: '/copied' });
		await expect(adapter.search?.('a.txt', { path: '/data' })).resolves.toEqual([
			expect.objectContaining({ path: '/data/a.txt' }),
		]);

		const requests = fetch.mock.calls.map(([url, init]) => [
			url,
			(init as RequestInit).method,
			(init as RequestInit).body,
		]);
		expect(requests.map(([url, method]) => [url, method])).toEqual([
			['/api/v1/projects/project-1/notebooks/notebook-1/workspace/directories', 'POST'],
			[
				'/api/v1/projects/project-1/notebooks/notebook-1/workspace/entries?path=%2Fdata%2Fold.txt',
				'DELETE',
			],
			['/api/v1/projects/project-1/notebooks/notebook-1/workspace/move', 'POST'],
			['/api/v1/projects/project-1/notebooks/notebook-1/workspace/copy', 'POST'],
			[
				'/api/v1/projects/project-1/notebooks/notebook-1/workspace/search?path=%2Fdata&query=a.txt',
				'GET',
			],
		]);
		expect(JSON.parse(requests[0]?.[2] as string)).toEqual({ path: '/data' });
		expect(JSON.parse(requests[2]?.[2] as string)).toEqual({ from: '/data', to: '/moved' });
	});

	it('uses create-only raw writes and returns encoded download URLs', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonOk({ path: '/folder/a b.txt', name: 'a b.txt', kind: 'file', size: 0 }),
			);
		vi.stubGlobal('fetch', fetch);
		const adapter = new WorkspaceAdapter('project-1', 'notebook-1', access);

		await adapter.createFile?.('/folder/a b.txt');
		expect(fetch).toHaveBeenCalledWith(
			'/api/v1/projects/project-1/notebooks/notebook-1/workspace/files?path=%2Ffolder%2Fa+b.txt&create=true',
			expect.objectContaining({ method: 'PUT', body: '' }),
		);
		expect(await adapter.getDownloadUrl?.('/folder/a b.txt')).toBe(
			'/api/v1/projects/project-1/notebooks/notebook-1/workspace/files?path=%2Ffolder%2Fa+b.txt',
		);
	});

	it.each([
		[403, 'permission'],
		[404, 'not_found'],
		[409, 'exists'],
		[500, 'unknown'],
	] as const)('maps raw HTTP %s errors to %s finder errors', async (status, code) => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					new Response(
						JSON.stringify({ success: false, error: { code: 'FAILED', message: 'failed' } }),
						{ status, headers: { 'content-type': 'application/json' } },
					),
				),
		);
		const adapter = new WorkspaceAdapter('project-1', 'notebook-1', access);

		await expect(adapter.readFile('/missing')).rejects.toMatchObject({ code, message: 'failed' });
	});

	it.each([
		['invalid JSON', new Response('not-json', { status: 200 })],
		[
			'missing data',
			new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		],
		[
			'invalid item',
			new Response(JSON.stringify({ success: true, data: { path: 42 } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		],
	])('rejects a successful raw write with %s', async (_label, response) => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
		const adapter = new WorkspaceAdapter('project-1', 'notebook-1', access);

		await expect(adapter.writeFile('/data.txt', 'content')).rejects.toMatchObject({
			code: 'unknown',
			message: 'Workspace returned an invalid response',
		});
	});
});
