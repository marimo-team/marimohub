import { BlobServiceClient } from '@azure/storage-blob';
import { describe, it } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core';
import {
	OBJECT_BROWSE_CONTRACT_SEED,
	objectBrowseContract,
} from '@marimo-hub/core/testing/object-browse-contract';
import { AzureBlobObjectBrowser } from './index';

const connectionString = process.env.MARIMOHUB_TEST_AZURE_CONNECTION_STRING;
const container = `object-browser-${process.pid}-${Date.now()}`;
const prefix = 'contract/';
const seed = OBJECT_BROWSE_CONTRACT_SEED;
const directObject = `${prefix}${seed.direct.path}`;
const nestedObject = `${prefix}${seed.nested.path}`;
const unicodeObject = `${prefix}${seed.unicode.path}`;
const emptyObject = `${prefix}${seed.empty.path}`;
const parquetObject = `${prefix}${seed.parquet.path}`;
const versionedObject = `${prefix}${seed.versioned.path}`;

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
				.uploadData(new TextEncoder().encode(seed.direct.body), {
					blobHTTPHeaders: { blobContentType: seed.direct.contentType },
				});
			await target
				.getBlockBlobClient(nestedObject)
				.uploadData(new TextEncoder().encode(seed.nested.body));
			await target
				.getBlockBlobClient(unicodeObject)
				.uploadData(new TextEncoder().encode(seed.unicode.body));
			await target.getBlockBlobClient(emptyObject).uploadData(new Uint8Array());
			await target.getBlockBlobClient(parquetObject).uploadData(seed.parquet.body, {
				blobHTTPHeaders: { blobContentType: seed.parquet.contentType },
			});
			await target
				.getBlockBlobClient(versionedObject)
				.uploadData(new TextEncoder().encode(seed.versioned.secondBody));
			return {
				bucket: container,
				prefix,
				directObject,
				nestedObject,
				unicodeObject,
				emptyObject,
				parquetObject,
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
