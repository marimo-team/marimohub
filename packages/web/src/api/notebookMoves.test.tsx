import { afterEach, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { createTestQueryClient, jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import { cachedProjectName, useCancelNotebookMove, useMoveNotebook } from './notebookMoves';
import { notebookKeys, projectKeys } from './queryKeys';
import { projectThumbnailsKey, thumbnailKey } from './thumbnails';

const input = {
	notebookId: 'nb-1',
	destination: 'proj-destination',
	updatedAt: '2026-11-04T12:00:00Z',
};

afterEach(() => {
	vi.unstubAllGlobals();
});

it('invalidates both galleries and notebook thumbnails after a successful move', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonOk({ id: input.notebookId, project_id: input.destination })),
	);
	const { result, client } = renderHookWithClient(() => useMoveNotebook('proj-source'), {
		toaster: false,
	});
	const keys = [
		projectThumbnailsKey('proj-source'),
		projectThumbnailsKey(input.destination),
		thumbnailKey('proj-source', input.notebookId),
		thumbnailKey(input.destination, input.notebookId),
	];
	for (const key of keys) client.setQueryData(key, { revision: 'old' });
	client.setQueryData(projectThumbnailsKey('proj-unrelated'), {});

	await act(async () => {
		await result.current.mutateAsync(input);
	});

	for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
	expect(client.getQueryState(projectThumbnailsKey('proj-unrelated'))?.isInvalidated).toBe(false);
});

it('keeps thumbnail caches intact when a move fails', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonError('CONFLICT', 'Move already running', 409)),
	);
	const { result, client } = renderHookWithClient(() => useMoveNotebook('proj-source'), {
		toaster: false,
	});
	const key = projectThumbnailsKey('proj-source');
	client.setQueryData(key, {});

	await act(async () => {
		await expect(result.current.mutateAsync(input)).rejects.toThrow('Move already running');
	});

	expect(client.getQueryState(key)?.isInvalidated).toBe(false);
});

it('cancels through DELETE and refreshes both projects', async () => {
	const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
		jsonOk({ message: 'Move cancelled' }),
	);
	vi.stubGlobal('fetch', fetch);
	const { result, client } = renderHookWithClient(() => useCancelNotebookMove('proj-source'), {
		toaster: false,
	});
	const keys = [
		notebookKeys.all,
		projectKeys.detail('proj-source'),
		projectKeys.detail(input.destination),
	];
	for (const key of keys) client.setQueryData(key, {});

	await act(async () => {
		await result.current.mutateAsync(input);
	});

	expect(String(fetch.mock.calls[0][0])).toContain(
		'/api/v1/projects/proj-source/notebooks/nb-1/move',
	);
	expect(fetch.mock.calls[0][1]?.method).toBe('DELETE');
	for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});

it('names a destination from any cached project roster without fetching', () => {
	const client = createTestQueryClient();
	client.setQueryData(projectKeys.filteredList({ status: 'active' }), [
		{ id: 'proj-destination', name: 'Destination' },
	]);
	expect(cachedProjectName(client, 'proj-destination')).toBe('Destination');
	expect(cachedProjectName(client, 'proj-unknown')).toBeUndefined();
});
