import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_PART_BYTES } from '@marimo-hub/core/uploads';
import { createProjectId, UserId } from '@marimo-hub/core/ids';
import type {
	AzureBlobObjectStoreSource,
	ObjectBrowseContext,
} from '@marimo-hub/core/ports/object-browser';
import { AzureBlobObjectBrowser } from './index';

const source: AzureBlobObjectStoreSource = {
	provider: 'azure_blob',
	configured_bucket: 'raw',
	account_name: 'lakeaccount',
	endpoint_suffix: 'core.windows.net',
	auth: { method: 'sas_token', sas_token: 'sig=secret' },
};
const context: ObjectBrowseContext = {
	project_id: createProjectId(),
	user_id: UserId.parse('user-1'),
	user_email: 'ada@example.com',
	allow_server_ambient: {},
};

describe('Azure Blob object browser', () => {
	it.each([
		{ method: 'account_key' as const, account_key: 'c2VjcmV0' },
		{ method: 'sas_token' as const, sas_token: 'sig=secret' },
		{
			method: 'connection_string' as const,
			connection_string:
				'DefaultEndpointsProtocol=https;AccountName=lakeaccount;AccountKey=c2VjcmV0;EndpointSuffix=core.windows.net',
		},
		{
			method: 'service_principal' as const,
			tenant_id: 'tenant',
			client_id: 'client',
			client_secret: 'secret',
		},
	])('constructs the $method authentication path without contacting the provider', (auth) => {
		const browser = new AzureBlobObjectBrowser({
			mode: 'metadata',
			resolveHost: async () => [{ address: '20.60.1.1', family: 4 }],
		});
		expect(browser.capability({ ...source, auth }, context)).toMatchObject({ available: true });
	});

	it('advertises container terminology and the az URI scheme', () => {
		const browser = new AzureBlobObjectBrowser({
			mode: 'full',
			resolveHost: async () => [{ address: '20.60.1.1', family: 4 }],
		});
		expect(browser.capability(source, context)).toMatchObject({
			available: true,
			provider: 'azure_blob',
			root_kind: 'container',
			uri_scheme: 'az',
		});
	});

	it('keeps ambient authorization provider-specific', () => {
		const browser = new AzureBlobObjectBrowser({
			mode: 'metadata',
			resolveHost: async () => [{ address: '20.60.1.1', family: 4 }],
		});
		const ambient = { ...source, auth: { method: 'ambient' as const } };
		expect(
			browser.capability(ambient, { ...context, allow_server_ambient: { gcs: true } }),
		).toMatchObject({ available: false, provider: 'azure_blob' });
		expect(
			browser.capability(ambient, { ...context, allow_server_ambient: { azure_blob: true } }),
		).toMatchObject({ available: true, provider: 'azure_blob' });
	});

	it('does not expose account secrets when the guarded resolver rejects a request', async () => {
		const browser = new AzureBlobObjectBrowser({
			mode: 'metadata',
			resolveHost: async () => {
				throw new Error('private network');
			},
		});
		await expect(browser.listObjects(source, context, { bucket: 'raw', limit: 1 })).rejects.toEqual(
			expect.objectContaining({
				code: 'unavailable',
				message: 'The Azure Blob request failed.',
			}),
		);
	});
});

describe('Azure Blob object uploads', () => {
	function fixture() {
		const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 201 }));
		return {
			fetcher,
			browser: new AzureBlobObjectBrowser({
				mode: 'full',
				fetchImpl: fetcher,
				resolveHost: async () => [{ address: '20.60.1.1', family: 4 }],
			}),
		};
	}
	const request = {
		bucket: 'raw',
		key: 'data',
		contentType: 'text/plain',
		size: 1,
		body: new Uint8Array([7]),
	};
	const writable = { ...source, allow_write: true };

	it.each([
		['without allow_write', source],
		['with ambient credentials', { ...writable, auth: { method: 'ambient' as const } }],
	])('denies uploads %s before contacting the provider', async (_, denied) => {
		const { browser, fetcher } = fixture();
		await expect(
			browser.putObject(
				denied,
				{ ...context, allow_server_ambient: { azure_blob: true } },
				request,
			),
		).rejects.toMatchObject({ code: 'access_denied' });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each([
		{ identity: { bucket: 'other' }, code: 'access_denied' },
		{ identity: { key: '..' }, code: 'not_found' },
		{ identity: { key: 'é'.repeat(513) }, code: 'not_found' },
	])('rejects an out-of-scope object %j', async ({ identity, code }) => {
		const { browser, fetcher } = fixture();
		await expect(
			browser.putObject(writable, context, { ...request, ...identity }),
		).rejects.toMatchObject({ code });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each([0, 2])('does not commit a body that mismatches declared size %i', async (size) => {
		const { browser, fetcher } = fixture();
		await expect(browser.putObject(writable, context, { ...request, size })).rejects.toThrow(
			'declared size',
		);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('does not commit previously staged blocks when the source ends early', async () => {
		const { browser, fetcher } = fixture();
		await expect(
			browser.putObject(writable, context, {
				...request,
				size: UPLOAD_PART_BYTES + 2,
				body: new Uint8Array(UPLOAD_PART_BYTES + 1),
			}),
		).rejects.toThrow('declared size');
		expect(fetcher).toHaveBeenCalledOnce();
		expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('comp')).toBe('block');
	});

	it('stages bounded blocks and commits their IDs in order with the content type', async () => {
		const { browser, fetcher } = fixture();
		const body = Uint8Array.from({ length: UPLOAD_PART_BYTES + 3 }, (_, i) => i % 251);
		await browser.putObject(writable, context, { ...request, body, size: body.length });
		const calls = fetcher.mock.calls;
		expect(calls).toHaveLength(3);
		const urls = calls.map(([url]) => new URL(String(url)));
		expect(urls.map((url) => url.searchParams.get('comp'))).toEqual([
			'block',
			'block',
			'blocklist',
		]);
		expect(
			Buffer.concat(
				calls.slice(0, 2).map(([, init]) => Buffer.from(init!.body as Uint8Array)),
			).equals(body),
		).toBe(true);
		const ids = urls.slice(0, 2).map((url) => url.searchParams.get('blockid')!);
		expect(ids[0]).not.toBe(ids[1]);
		const commit = calls[2][1]!;
		expect(String(commit.body)).toContain(`<Latest>${ids[0]}</Latest><Latest>${ids[1]}</Latest>`);
		expect(new Headers(commit.headers).get('x-ms-blob-content-type')).toBe('text/plain');
	});
});
