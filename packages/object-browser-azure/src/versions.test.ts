import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core';
import type { AzureBlobObjectStoreSource, ObjectBrowseContext } from '@marimo-hub/core';
import { AzureBlobObjectBrowser } from './index';

const azure = vi.hoisted(() => ({ next: vi.fn() }));

vi.mock('./client', () => ({
	createAzureClient: () => ({
		getContainerClient: () => ({
			listBlobsFlat: () => ({ byPage: () => ({ next: azure.next }) }),
		}),
	}),
}));

const source: AzureBlobObjectStoreSource = {
	provider: 'azure_blob',
	configured_bucket: 'raw',
	account_name: 'lakeaccount',
	endpoint_suffix: 'core.windows.net',
	auth: { method: 'account_key', account_key: 'secret' },
};
const context: ObjectBrowseContext = {
	project_id: createProjectId(),
	user_id: UserId.parse('azure-version-user'),
	user_email: 'azure-version@example.com',
	allow_server_ambient: {},
};
const browser = new AzureBlobObjectBrowser({
	mode: 'metadata',
	resolveHost: async () => [{ address: '20.60.1.1', family: 4 }],
});

beforeEach(() => azure.next.mockReset());

describe('Azure Blob versions', () => {
	it('maps native version IDs and excludes soft-deleted blobs', async () => {
		azure.next.mockResolvedValue({
			done: false,
			value: {
				segment: {
					blobItems: [
						version('report.csv', 'current', true),
						version('report.csv', 'older', false),
						{ ...version('report.csv', 'deleted', false), deleted: true },
						version('report.csv.bak', 'other', true),
					],
				},
			},
		});
		await expect(
			browser.listVersions(source, context, {
				bucket: 'raw',
				key: 'report.csv',
				limit: 10,
			}),
		).resolves.toMatchObject({
			items: [
				{ kind: 'version', version_id: 'current', is_latest: true },
				{ kind: 'version', version_id: 'older', is_latest: false },
			],
			next_cursor: null,
		});
	});

	it('returns terminal empty history when listing only yields an unversioned current blob', async () => {
		azure.next.mockResolvedValue({
			done: false,
			value: {
				segment: {
					blobItems: [
						{
							name: 'report.csv',
							properties: { contentLength: 3 },
						},
					],
				},
			},
		});
		await expect(
			browser.listVersions(source, context, {
				bucket: 'raw',
				key: 'report.csv',
				limit: 10,
			}),
		).resolves.toEqual({ items: [], next_cursor: null });
	});

	it.each(['FeatureVersionMismatch', 'UnsupportedHeader', 'UnsupportedQueryParameter'])(
		'treats %s as empty terminal history',
		async (code) => {
			azure.next.mockResolvedValue({
				done: false,
				get value() {
					throw Object.assign(new Error('provider detail'), { code });
				},
			});
			await expect(
				browser.listVersions(source, context, {
					bucket: 'raw',
					key: 'report.csv',
					limit: 10,
				}),
			).resolves.toEqual({ items: [], next_cursor: null });
		},
	);
});

function version(name: string, versionId: string, isCurrentVersion: boolean) {
	return {
		name,
		versionId,
		isCurrentVersion,
		deleted: false,
		properties: {
			contentLength: 3,
			etag: `etag-${versionId}`,
			lastModified: new Date('2026-08-13T00:00:00Z'),
			accessTier: 'Hot',
		},
	};
}
