import { describe, expect, it } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core';
import type { AzureBlobObjectStoreSource, ObjectBrowseContext } from '@marimo-hub/core';
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
