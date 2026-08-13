import { BlobServiceClient } from '@azure/storage-blob';
import { describe, it } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core';
import { objectBrowseContract } from '@marimo-hub/core/testing/object-browse-contract';
import { AzureBlobObjectBrowser } from './index';

const connectionString = process.env.MARIMOHUB_TEST_AZURE_CONNECTION_STRING;
const container = `object-browser-${process.pid}-${Date.now()}`;
const prefix = 'contract/';
const directObject = `${prefix}contract.csv`;
const nestedObject = `${prefix}nested/contract.txt`;
const unicodeObject = `${prefix}résumé-雪.txt`;
const emptyObject = `${prefix}empty.bin`;
const versionedObject = `${prefix}versioned.txt`;

if (connectionString) {
	objectBrowseContract('Azurite', () => ({
		browser: new AzureBlobObjectBrowser({
			mode: 'full',
			resolveHost: async (hostname) => {
				if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
					throw new Error('unexpected Azurite hostname');
				}
				return [{ address: '127.0.0.1', family: 4 }];
			},
		}),
		source: {
			provider: 'azure_blob',
			configured_bucket: container,
			account_name: 'devstoreaccount1',
			endpoint_suffix: 'core.windows.net',
			auth: { method: 'connection_string', connection_string: connectionString },
		},
		context: {
			project_id: createProjectId(),
			user_id: UserId.parse('azurite-contract'),
			user_email: 'azurite-contract@example.com',
			allow_server_ambient: {},
		},
		async setup() {
			const client = BlobServiceClient.fromConnectionString(connectionString);
			const target = client.getContainerClient(container);
			await target.create();
			await target
				.getBlockBlobClient(directObject)
				.uploadData(new TextEncoder().encode('name,value\nfirst,1\nsecond,2\n'), {
					blobHTTPHeaders: { blobContentType: 'text/csv' },
				});
			await target
				.getBlockBlobClient(nestedObject)
				.uploadData(new TextEncoder().encode('nested contract'));
			await target
				.getBlockBlobClient(unicodeObject)
				.uploadData(new TextEncoder().encode('unicode contract'));
			await target.getBlockBlobClient(emptyObject).uploadData(new Uint8Array());
			await target
				.getBlockBlobClient(versionedObject)
				.uploadData(new TextEncoder().encode('current version'));
			return {
				bucket: container,
				prefix,
				directObject,
				nestedObject,
				unicodeObject,
				emptyObject,
				versionedObject,
				versions: false,
			};
		},
		async teardown() {
			const client = BlobServiceClient.fromConnectionString(connectionString);
			await client.getContainerClient(container).deleteIfExists();
		},
	}));
} else {
	describe.skip('Object browse contract: Azurite', () => {
		it('requires MARIMOHUB_TEST_AZURE_CONNECTION_STRING', () => {});
	});
}
