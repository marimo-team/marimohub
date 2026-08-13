import { describe, expect, it, vi } from 'vitest';
import type { Metrics, ObjectStoreProvider } from '@marimo-hub/core';
import { ObjectBrowseError } from '@marimo-hub/core';
import { ObjectBrowserObserver } from './metrics';
import { DEFAULT_OBJECT_BROWSER_LIMITS } from './limits';

describe('provider-neutral object-browser metrics', () => {
	it.each(['s3', 'gcs', 'azure_blob'] as const)(
		'emits provider-scoped names and low-cardinality tags for %s',
		async (provider) => {
			const metrics = recorder();
			const observer = new ObjectBrowserObserver(provider, 'full', metrics);
			await observer.observe('list_objects', sensitiveContext(), async () => {});
			observer.keysScanned(4);
			observer.previewRead(
				{
					kind: 'text',
					format: 'text',
					text: 'safe',
					truncated: false,
					bytes_read: 4,
					total_bytes: 4,
					warnings: [],
				},
				DEFAULT_OBJECT_BROWSER_LIMITS,
			);
			expect(metrics.increment.mock.calls.map(([name]) => name)).toEqual([
				`object_browser.${provider}.operations`,
				`object_browser.${provider}.keys_scanned`,
				`object_browser.${provider}.bytes_read`,
			]);
			for (const call of [...metrics.increment.mock.calls, ...metrics.histogram.mock.calls]) {
				expect(JSON.stringify(call[2])).not.toMatch(/secret-bucket|private\/key|ada@example/);
			}
		},
	);

	it('records sanitized failure codes without provider error text', async () => {
		const metrics = recorder();
		const observer = new ObjectBrowserObserver('gcs', 'metadata', metrics);
		await expect(
			observer.observe('head_object', sensitiveContext(), async () => {
				throw new ObjectBrowseError('access_denied', 'provider secret');
			}),
		).rejects.toMatchObject({ code: 'access_denied' });
		expect(metrics.increment).toHaveBeenLastCalledWith('object_browser.gcs.failures', 1, {
			operation: 'head_object',
			mode: 'metadata',
			code: 'access_denied',
		});
	});
});

function sensitiveContext() {
	return {
		project_id: 'proj-secret' as never,
		user_id: 'user-secret' as never,
		user_email: 'ada@example.com',
		allow_server_ambient: {} as Partial<Record<ObjectStoreProvider, boolean>>,
	};
}

function recorder() {
	return {
		increment: vi.fn<Metrics['increment']>(),
		gauge: vi.fn<Metrics['gauge']>(),
		histogram: vi.fn<NonNullable<Metrics['histogram']>>(),
	};
}
