import { Readable } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core';
import {
	OBJECT_BROWSE_CONTRACT_SEED,
	objectBrowseContract,
} from '@marimo-hub/core/testing/object-browse-contract';
import type { ObjectBrowseContext } from '@marimo-hub/core';

const fake = vi.hoisted(() => ({ createAzureClient: vi.fn() }));
vi.mock('./client', () => fake);

import { AzureBlobObjectBrowser } from './index';

const bucket = 'contract-lake';
const prefix = 'contract/';
const seed = OBJECT_BROWSE_CONTRACT_SEED;
const directObject = `${prefix}${seed.direct.path}`;
const nestedObject = `${prefix}${seed.nested.path}`;
const unicodeObject = `${prefix}${seed.unicode.path}`;
const emptyObject = `${prefix}${seed.empty.path}`;
const parquetObject = `${prefix}${seed.parquet.path}`;
const versionedObject = `${prefix}${seed.versioned.path}`;
const imageObject = `${prefix}pixel.png`;
const records = [
	record(parquetObject, '14', seed.parquet.body, seed.parquet.contentType),
	record(directObject, '13', seed.direct.body, seed.direct.contentType),
	record(nestedObject, '12', seed.nested.body, seed.nested.contentType),
	record(unicodeObject, '9', seed.unicode.body, seed.unicode.contentType),
	record(emptyObject, '8', seed.empty.body, seed.empty.contentType),
	record(versionedObject, '11', seed.versioned.secondBody, seed.versioned.contentType),
	record(versionedObject, '10', seed.versioned.firstBody, seed.versioned.contentType),
	record(imageObject, '15', Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'),
];

const source = {
	provider: 'azure_blob' as const,
	account_name: 'contract',
	endpoint_suffix: 'core.windows.net',
	auth: { method: 'sas_token' as const, sas_token: 'sig=fake' },
};
const context: ObjectBrowseContext = {
	project_id: createProjectId(),
	user_id: UserId.parse('azure-contract'),
	user_email: 'azure-contract@example.com',
	allow_server_ambient: {},
};

beforeEach(() => {
	fake.createAzureClient.mockImplementation((_source, requestContext) =>
		serviceClient(requestContext.signal),
	);
});

objectBrowseContract('hermetic Azure SDK transport', () => ({
	browser: browser(),
	source,
	context,
	async setup() {
		return {
			bucket,
			prefix,
			directObject,
			nestedObject,
			unicodeObject,
			emptyObject,
			parquetObject,
			versionedObject,
		};
	},
}));

it('allows only bounded, signature-verified raster images inline', async () => {
	const body = await browser().openObject(source, context, {
		bucket,
		key: imageObject,
		inline: true,
	});
	try {
		expect(body.content_type).toBe('image/png');
	} finally {
		body.close();
	}
	await expect(
		browser().openObject(source, context, { bucket, key: directObject, inline: true }),
	).rejects.toMatchObject({ code: 'unsupported' });
	await expect(
		browser({ inlineImageMaxBytes: 4 }).openObject(source, context, {
			bucket,
			key: imageObject,
			inline: true,
		}),
	).rejects.toMatchObject({ code: 'unsupported' });
});

function browser(limits = {}) {
	return new AzureBlobObjectBrowser({
		mode: 'full',
		limits,
		resolveHost: async () => [{ address: '20.60.1.1', family: 4 }],
	});
}

interface RecordValue {
	name: string;
	versionId: string;
	data: Uint8Array;
	contentType: string;
	lastModified: Date;
	etag: string;
}

function record(
	name: string,
	versionId: string,
	value: string | Uint8Array,
	contentType: string,
): RecordValue {
	return {
		name,
		versionId,
		data: typeof value === 'string' ? new TextEncoder().encode(value) : value,
		contentType,
		lastModified: new Date(`2026-08-13T00:00:${versionId.padStart(2, '0')}Z`),
		etag: `"etag-${versionId}"`,
	};
}

function currentRecords(): RecordValue[] {
	return records.filter(
		(item, index) => records.findIndex((candidate) => candidate.name === item.name) === index,
	);
}

function serviceClient(signal?: AbortSignal) {
	return {
		listContainers: () =>
			paged(
				() => [{ name: bucket, properties: { lastModified: new Date() } }],
				'containers',
				signal,
			),
		getContainerClient: () => containerClient(signal),
	};
}

function containerClient(signal?: AbortSignal) {
	return {
		listBlobsByHierarchy: (_delimiter: string, options: { prefix?: string }) =>
			paged(() => hierarchy(options.prefix ?? ''), 'blobs', signal),
		listBlobsFlat: (options: { prefix?: string; includeVersions?: boolean }) =>
			paged(
				() =>
					(options.includeVersions ? records : currentRecords())
						.filter((item) => item.name.startsWith(options.prefix ?? ''))
						.map(blobItem),
				'blobs',
				signal,
			),
		getBlobClient: (name: string) => blobClient(name),
	};
}

function hierarchy(requestedPrefix: string) {
	const prefixes = new Set<string>();
	const blobs: ReturnType<typeof blobItem>[] = [];
	for (const item of currentRecords()) {
		if (!item.name.startsWith(requestedPrefix)) continue;
		const remainder = item.name.slice(requestedPrefix.length);
		const slash = remainder.indexOf('/');
		if (slash !== -1) prefixes.add(`${requestedPrefix}${remainder.slice(0, slash + 1)}`);
		else blobs.push(blobItem(item));
	}
	return [...[...prefixes].map((name) => ({ prefix: name })), ...blobs].sort((left, right) =>
		('prefix' in left ? left.prefix : left.name).localeCompare(
			'prefix' in right ? right.prefix : right.name,
		),
	);
}

function paged(load: () => unknown[], kind: 'containers' | 'blobs', signal?: AbortSignal) {
	return {
		byPage: ({
			continuationToken,
			maxPageSize,
		}: {
			continuationToken?: string;
			maxPageSize?: number;
		}) => ({
			async next() {
				if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
				const values = load();
				const offset = Number(continuationToken ?? '0');
				const size = maxPageSize ?? values.length;
				const selected = values.slice(offset, offset + size);
				const next =
					offset + selected.length < values.length ? String(offset + selected.length) : '';
				if (kind === 'containers') {
					return { done: false, value: { containerItems: selected, continuationToken: next } };
				}
				const blobPrefixes = selected.flatMap((value) =>
					typeof value === 'object' && value !== null && 'prefix' in value
						? [{ name: value.prefix }]
						: [],
				);
				const blobItems = selected.filter(
					(value) => !(typeof value === 'object' && value !== null && 'prefix' in value),
				);
				return {
					done: false,
					value: { continuationToken: next, segment: { blobPrefixes, blobItems } },
				};
			},
		}),
	};
}

function blobItem(item: RecordValue) {
	return {
		name: item.name,
		versionId: item.versionId,
		isCurrentVersion: currentRecords().includes(item),
		deleted: false,
		properties: properties(item),
	};
}

function properties(item: RecordValue) {
	return {
		contentLength: item.data.byteLength,
		contentType: item.contentType,
		lastModified: item.lastModified,
		etag: item.etag,
		metadata: {},
	};
}

function blobClient(name: string, versionId?: string): Record<string, unknown> {
	const get = () => {
		const candidates = records.filter((item) => item.name === name);
		const item = versionId
			? candidates.find((candidate) => candidate.versionId === versionId)
			: candidates[0];
		if (!item) throw azureError(404, 'BlobNotFound');
		return item;
	};
	return {
		withVersion: (version: string) => blobClient(name, version),
		getProperties: async () => properties(get()),
		getTags: async () => ({ tags: {} }),
		download: async (
			offset = 0,
			count?: number,
			options?: { conditions?: { ifMatch?: string } },
		) => {
			const item = get();
			if (options?.conditions?.ifMatch && options.conditions.ifMatch !== item.etag) {
				throw azureError(412, 'ConditionNotMet');
			}
			if (offset >= item.data.byteLength && item.data.byteLength !== 0) {
				throw azureError(416, 'InvalidRange');
			}
			const end =
				count === undefined ? item.data.byteLength : Math.min(item.data.byteLength, offset + count);
			const data = item.data.slice(offset, end);
			const ranged = offset > 0 || count !== undefined;
			return {
				readableStreamBody: Readable.from([Buffer.from(data)]),
				contentLength: data.byteLength,
				contentType: item.contentType,
				contentRange: ranged
					? `bytes ${offset}-${Math.max(offset, end - 1)}/${item.data.byteLength}`
					: undefined,
				etag: item.etag,
				versionId: item.versionId,
			};
		},
	};
}

function azureError(statusCode: number, code: string) {
	return Object.assign(new Error(code), { statusCode, code });
}
