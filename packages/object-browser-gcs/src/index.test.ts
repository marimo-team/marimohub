import { GcsAuth } from './auth';
import { describe, expect, it, vi } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core/ids';
import { ObjectBrowseError } from '@marimo-hub/core/ports/object-browser';
import type {
	GcsObjectStoreSource,
	ObjectBrowseContext,
} from '@marimo-hub/core/ports/object-browser';
import type { ObjectBrowserLimits } from '@marimo-hub/object-browser-commons';
import { GcsObjectBrowser } from './index';

const source: GcsObjectStoreSource = {
	provider: 'gcs',
	configured_bucket: 'lake',
	auth: { method: 'ambient' },
};
const context: ObjectBrowseContext = {
	project_id: createProjectId(),
	user_id: UserId.parse('user-1'),
	user_email: 'ada@example.com',
	allow_server_ambient: { gcs: true },
};

function browser(fetchImpl: typeof fetch, limits?: Partial<ObjectBrowserLimits>) {
	return new GcsObjectBrowser({
		mode: 'full',
		fetchImpl,
		...(limits === undefined ? {} : { limits }),
		resolveHost: async () => [{ address: '142.250.1.1', family: 4 }],
	});
}

describe('GCS object browser', () => {
	it('maps hierarchy, sizes, and opaque page tokens', async () => {
		const fetchImpl = async (input: URL | RequestInfo) => {
			const url = String(input);
			if (url.includes('metadata.google.internal')) {
				return Response.json({ access_token: 'token', expires_in: 3600 });
			}
			return Response.json({
				prefixes: ['folder/nested/'],
				items: [
					{
						name: 'folder/file.csv',
						generation: '7',
						size: '12',
						updated: '2026-01-01T00:00:00Z',
					},
				],
				nextPageToken: 'opaque',
			});
		};
		const page = await browser(fetchImpl as typeof fetch).listObjects(source, context, {
			bucket: 'lake',
			prefix: 'folder/',
			limit: 2,
		});
		expect(page.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'object', key: 'folder/file.csv', size: 12 }),
				expect.objectContaining({ kind: 'prefix', key: 'folder/nested/' }),
			]),
		);
		expect(page.next_cursor).not.toBeNull();
		await expect(
			browser(fetchImpl as typeof fetch).listObjects(source, context, {
				bucket: 'lake',
				prefix: 'folder/',
				limit: 2,
				cursor: page.next_cursor!,
			}),
		).rejects.toMatchObject({ code: 'invalid_cursor' });
	});

	it('sanitizes malformed and denied provider responses', async () => {
		const denied = browser((async (input: URL | RequestInfo) => {
			if (String(input).includes('metadata.google.internal')) {
				return Response.json({ access_token: 'token', expires_in: 3600 });
			}
			return new Response('secret-provider-detail', { status: 403 });
		}) as typeof fetch);
		await expect(denied.listObjects(source, context, { bucket: 'lake', limit: 1 })).rejects.toEqual(
			expect.objectContaining({ code: 'access_denied', message: 'Access to GCS was denied.' }),
		);

		const malformed = browser((async (input: URL | RequestInfo) => {
			if (String(input).includes('metadata.google.internal')) {
				return Response.json({ access_token: 'token', expires_in: 3600 });
			}
			return Response.json({ items: 'not-an-array' });
		}) as typeof fetch);
		await expect(
			malformed.listObjects(source, context, { bucket: 'lake', limit: 1 }),
		).rejects.toEqual(expect.objectContaining({ code: 'unavailable' }));

		const malformedItem = browser((async (input: URL | RequestInfo) => {
			if (String(input).includes('metadata.google.internal')) {
				return Response.json({ access_token: 'token', expires_in: 3600 });
			}
			return Response.json({ items: [{}] });
		}) as typeof fetch);
		await expect(
			malformedItem.listObjects(source, context, { bucket: 'lake', limit: 1 }),
		).rejects.toEqual(
			expect.objectContaining({
				code: 'unavailable',
				message: 'GCS returned a malformed response.',
			}),
		);
	});

	it('requests only the consumed fields from list pages', async () => {
		const listUrls: string[] = [];
		const fetchImpl = (async (input: URL | RequestInfo) => {
			const url = String(input);
			if (url.includes('metadata.google.internal')) {
				return Response.json({ access_token: 'token', expires_in: 3600 });
			}
			listUrls.push(url);
			return Response.json({ items: [] });
		}) as typeof fetch;
		await browser(fetchImpl).listObjects(source, context, { bucket: 'lake', limit: 2 });
		await browser(fetchImpl).searchObjects(source, context, {
			bucket: 'lake',
			query: 'report',
			limit: 2,
		});
		expect(listUrls).toHaveLength(2);
		for (const url of listUrls) {
			expect(new URL(url).searchParams.get('fields')).toBe(
				'items(name,generation,size,updated,etag,storageClass),prefixes,nextPageToken',
			);
		}
	});

	it('caps list and metadata response bodies independently', async () => {
		const fetchImpl = (async (input: URL | RequestInfo) => {
			const url = String(input);
			if (url.includes('metadata.google.internal')) {
				return Response.json({ access_token: 'token', expires_in: 3600 });
			}
			if (url.includes('/o/report.csv')) {
				return Response.json({ name: 'report.csv', generation: '9', size: '3' });
			}
			return Response.json({ items: [], padding: 'x'.repeat(64) });
		}) as typeof fetch;
		await expect(
			browser(fetchImpl, { listMaxResponseBytes: 16 }).listObjects(source, context, {
				bucket: 'lake',
				limit: 1,
			}),
		).rejects.toMatchObject({ code: 'unsupported' });
		await expect(
			browser(fetchImpl, { metadataMaxResponseBytes: 16 }).listObjects(source, context, {
				bucket: 'lake',
				limit: 1,
			}),
		).resolves.toMatchObject({ items: [] });
		await expect(
			browser(fetchImpl, { metadataMaxResponseBytes: 16 }).headObject(source, context, {
				bucket: 'lake',
				key: 'report.csv',
			}),
		).rejects.toMatchObject({ code: 'unsupported' });
	});

	it('marks the current generation as latest independently of version pagination', async () => {
		let tokenRequests = 0;
		const fetchImpl = async (input: URL | RequestInfo) => {
			const url = String(input);
			if (url.includes('metadata.google.internal')) {
				tokenRequests += 1;
				return Response.json({ access_token: 'token', expires_in: 3600 });
			}
			if (url.includes('/o/report.csv') && !url.includes('versions=true')) {
				return Response.json({ name: 'report.csv', generation: '9', size: '3' });
			}
			return Response.json({
				items: [
					{ name: 'report.csv', generation: '9', size: '3' },
					{ name: 'report.csv', generation: '8', size: '3' },
				],
				nextPageToken: 'older',
			});
		};
		const page = await browser(fetchImpl as typeof fetch).listVersions(source, context, {
			bucket: 'lake',
			key: 'report.csv',
			limit: 2,
		});
		expect(page.items.map(({ version_id, is_latest }) => ({ version_id, is_latest }))).toEqual([
			{ version_id: '9', is_latest: true },
			{ version_id: '8', is_latest: false },
		]);
		expect(tokenRequests).toBe(1);
	});

	it('keeps ambient authorization provider-specific', () => {
		const capability = browser(fetch).capability(source, {
			...context,
			allow_server_ambient: { s3: true },
		});
		expect(capability).toMatchObject({ available: false, provider: 'gcs' });
		expect(() => {
			throw new ObjectBrowseError('access_denied', capability.reason ?? '');
		}).toThrow(/Ambient GCS/);
	});

	it.each(['..', '.'])(
		'rejects dot-segment key %s before fetching object metadata',
		async (key) => {
			const fetchImpl = vi.fn<typeof fetch>();
			await expect(
				browser(fetchImpl).headObject(source, context, { bucket: 'lake', key }),
			).rejects.toMatchObject({ code: 'not_found' });
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);
});

describe('GCS object uploads', () => {
	it('keeps ambient credentials read-only even with allow_write', async () => {
		const fetcher = vi.fn();
		const writable = { ...source, allow_write: true };
		const target = browser(fetcher);
		expect(target.capability(writable, context).write).toBe(false);
		await expect(
			target.putObject(writable, context, {
				bucket: 'lake',
				key: 'data',
				contentType: 'application/octet-stream',
				size: 0,
				body: new Uint8Array(),
			}),
		).rejects.toMatchObject({ code: 'access_denied' });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('publishes bounded resumable ranges with explicit service-account credentials', async () => {
		const auth = vi
			.spyOn(GcsAuth.prototype, 'headers')
			.mockResolvedValue({ Authorization: 'Bearer token' });
		try {
			const requests: RequestInit[] = [];
			const target = browser((async (_url, init) => {
				requests.push(init!);
				if (init!.method === 'POST')
					return new Response(null, {
						headers: { location: 'https://storage.googleapis.com/upload/session' },
					});
				return new Response(null, { status: requests.length === 2 ? 308 : 200 });
			}) as typeof fetch);
			const writable: GcsObjectStoreSource = {
				...source,
				allow_write: true,
				auth: {
					method: 'service_account',
					credentials_json: JSON.stringify({
						client_email: 'test@example.com',
						private_key: 'test',
					}),
				},
			};
			await target.putObject(writable, context, {
				bucket: 'lake',
				key: 'data',
				contentType: 'application/octet-stream',
				size: 8 * 1024 * 1024 + 1,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(8 * 1024 * 1024));
						controller.enqueue(new Uint8Array([7]));
						controller.close();
					},
				}),
			});
			expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT', 'PUT']);
			expect(new Headers(requests[1].headers).get('content-range')).toBe('bytes 0-8388607/8388609');
			expect(new Headers(requests[2].headers).get('content-range')).toBe(
				'bytes 8388608-8388608/8388609',
			);
		} finally {
			auth.mockRestore();
		}
	});
});
