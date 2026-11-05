import { afterEach, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import { useMoveNotebook } from './notebookMoves';
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
