import { describe, expect, it, vi } from 'vitest';
import { UserId } from '@marimo-hub/core/ids';
import type {
	ObjectBrowser,
	ObjectBrowseContext,
	S3ObjectStoreSource,
} from '@marimo-hub/core/ports/object-browser';
import { protectControlPlaneBucket } from './objectBrowserPolicy';

const source: S3ObjectStoreSource = {
	provider: 's3',
	path_style: false,
	auth: { method: 'ambient' },
};
const context: ObjectBrowseContext = {
	user_id: UserId.parse('user-0000000000000000'),
	user_email: 'user@example.com',
	allow_server_ambient: { s3: true },
};
function fixture() {
	const capability = {
		provider: 's3' as const,
		root_kind: 'bucket' as const,
		uri_scheme: 's3' as const,
		available: true,
		preview: true,
		download: true,
		search: 'none' as const,
		versions: true,
		preview_formats: [],
	};
	const browser: ObjectBrowser<'s3'> = {
		provider: 's3',
		capability: vi.fn(() => capability),
		listBuckets: vi.fn(async () => ({
			items: [
				{ name: 'hub', configured: false },
				{ name: 'data', configured: false },
			],
			next_cursor: 'next',
		})),
		listObjects: vi.fn(),
		searchObjects: vi.fn(),
		headObject: vi.fn(),
		listVersions: vi.fn(),
		previewObject: vi.fn(),
		openObject: vi.fn(),
	};
	return { browser, guarded: protectControlPlaneBucket(browser, 'hub') };
}
describe('control-plane bucket protection', () => {
	it.each([
		'listObjects',
		'searchObjects',
		'headObject',
		'listVersions',
		'previewObject',
		'openObject',
	] as const)('blocks %s before calling the provider', async (method) => {
		const { browser, guarded } = fixture();
		await expect(
			guarded[method](source, context, {
				bucket: 'hub',
				key: 'secret',
				limit: 1,
				query: 'secret',
				content_url: 'https://hub.example.com/content',
			}),
		).rejects.toThrow('Control-plane storage');
		expect(browser[method]).not.toHaveBeenCalled();
		await guarded[method](source, context, {
			bucket: 'data',
			key: 'file',
			limit: 1,
			query: 'file',
			content_url: 'https://hub.example.com/content',
		});
		expect(browser[method]).toHaveBeenCalledOnce();
	});
	it('filters bucket pages while preserving cursors and rejects a configured hub bucket', async () => {
		const { browser, guarded } = fixture();
		expect(await guarded.listBuckets(source, context, { limit: 10 })).toEqual({
			items: [{ name: 'data', configured: false }],
			next_cursor: 'next',
		});
		const configured = { ...source, configured_bucket: 'hub' };
		await expect(guarded.listBuckets(configured, context, { limit: 10 })).rejects.toThrow(
			'Control-plane storage',
		);
		expect(browser.listBuckets).toHaveBeenCalledOnce();
		expect(await guarded.capability(configured, context)).toMatchObject({
			available: false,
			preview: false,
			download: false,
		});
	});
	it('preserves explicit credentials and is a no-op without control-plane storage', async () => {
		const { browser, guarded } = fixture();
		const explicit: S3ObjectStoreSource = {
			...source,
			auth: { method: 'static', access_key_id: 'key', secret_access_key: 'secret' },
		};
		await guarded.headObject(explicit, context, { bucket: 'hub', key: 'file' });
		expect(browser.headObject).toHaveBeenCalledWith(explicit, context, {
			bucket: 'hub',
			key: 'file',
		});
		expect((await guarded.listBuckets(explicit, context, { limit: 10 })).items).toHaveLength(2);
		expect(protectControlPlaneBucket(browser, undefined)).toBe(browser);
	});
});
