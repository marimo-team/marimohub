import { Buffer } from 'node:buffer';
import { createProjectId, UserId } from '@marimo-hub/core';
import { objectBrowseContract } from '@marimo-hub/core/testing/object-browse-contract';
import { GcsObjectBrowser } from './index';

const bucket = 'contract-lake';
const prefix = 'contract/';
const directObject = `${prefix}contract.csv`;
const nestedObject = `${prefix}nested/contract.txt`;
const unicodeObject = `${prefix}résumé-雪.txt`;
const emptyObject = `${prefix}empty.bin`;
const versionedObject = `${prefix}versioned.txt`;
const objects = [
	object(directObject, '13', 'name,value\nfirst,1\nsecond,2\n', 'text/csv'),
	object(nestedObject, '12', 'nested contract', 'text/plain'),
	object(unicodeObject, '9', 'unicode contract', 'text/plain'),
	object(emptyObject, '8', '', 'application/octet-stream'),
	object(versionedObject, '11', 'version two', 'text/plain'),
	object(versionedObject, '10', 'version one', 'text/plain'),
];

objectBrowseContract('hermetic GCS JSON API', () => ({
	browser: new GcsObjectBrowser({
		mode: 'full',
		fetchImpl: fakeGcsFetch as typeof fetch,
		resolveHost: async () => [{ address: '142.250.1.1', family: 4 }],
	}),
	source: {
		provider: 'gcs',
		configured_bucket: bucket,
		auth: { method: 'ambient' },
	},
	context: {
		project_id: createProjectId(),
		user_id: UserId.parse('gcs-contract'),
		user_email: 'gcs-contract@example.com',
		allow_server_ambient: { gcs: true },
	},
	async setup() {
		return {
			bucket,
			prefix,
			directObject,
			nestedObject,
			unicodeObject,
			emptyObject,
			versionedObject,
		};
	},
}));

interface FakeObject {
	name: string;
	generation: string;
	data: Uint8Array;
	contentType: string;
	updated: string;
	etag: string;
}

function object(name: string, generation: string, value: string, contentType: string): FakeObject {
	return {
		name,
		generation,
		data: new TextEncoder().encode(value),
		contentType,
		updated: `2026-08-13T00:00:${generation}Z`,
		etag: `etag-${generation}`,
	};
}

async function fakeGcsFetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
	if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
	const url = new URL(String(input));
	if (url.hostname === 'metadata.google.internal') {
		return Response.json({ access_token: 'ambient-token', expires_in: 3_600 });
	}
	if (url.hostname !== 'storage.googleapis.com') return new Response(null, { status: 502 });
	const collection = `/storage/v1/b/${bucket}/o`;
	if (url.pathname === collection) return listObjects(url);
	if (!url.pathname.startsWith(`${collection}/`)) return new Response(null, { status: 404 });
	const name = decodeURIComponent(url.pathname.slice(collection.length + 1));
	const generation = url.searchParams.get('generation');
	const candidates = objects.filter((item) => item.name === name);
	const item = generation
		? candidates.find((candidate) => candidate.generation === generation)
		: candidates.at(0);
	if (!item) return new Response(null, { status: 404 });
	if (url.searchParams.get('alt') !== 'media') return Response.json(resource(item));
	const ifMatch = new Headers(init?.headers).get('if-match');
	if (ifMatch && ifMatch !== item.etag) {
		return new Response(null, { status: 412 });
	}
	return media(item, init?.headers);
}

function listObjects(url: URL): Response {
	const includeVersions = url.searchParams.get('versions') === 'true';
	const requestedPrefix = url.searchParams.get('prefix') ?? '';
	const startOffset = url.searchParams.get('startOffset');
	const delimiter = url.searchParams.get('delimiter');
	const max = Number(url.searchParams.get('maxResults') ?? '1000');
	const offset = Number(url.searchParams.get('pageToken') ?? '0');
	const current = includeVersions
		? objects
		: objects.filter(
				(item, index) => objects.findIndex((candidate) => candidate.name === item.name) === index,
			);
	const entries = new Map<string, { kind: 'item'; value: FakeObject } | { kind: 'prefix' }>();
	for (const item of current) {
		if (!item.name.startsWith(requestedPrefix)) continue;
		if (startOffset && item.name < startOffset) continue;
		const remainder = item.name.slice(requestedPrefix.length);
		const boundary = delimiter ? remainder.indexOf(delimiter) : -1;
		if (boundary >= 0) {
			const child = `${requestedPrefix}${remainder.slice(0, boundary + 1)}`;
			entries.set(`prefix:${child}`, { kind: 'prefix' });
		} else {
			entries.set(`item:${item.name}:${item.generation}`, { kind: 'item', value: item });
		}
	}
	const ordered = [...entries.entries()].sort(([leftKey, left], [rightKey, right]) => {
		if (left.kind === 'item' && right.kind === 'item' && left.value.name === right.value.name) {
			return BigInt(left.value.generation) > BigInt(right.value.generation) ? -1 : 1;
		}
		return leftKey.localeCompare(rightKey);
	});
	const selected = ordered.slice(offset, offset + max);
	const items = selected.flatMap(([, entry]) =>
		entry.kind === 'item' ? [resource(entry.value)] : [],
	);
	const prefixes = selected.flatMap(([key, entry]) =>
		entry.kind === 'prefix' ? [key.slice('prefix:'.length)] : [],
	);
	return Response.json({
		...(items.length > 0 ? { items } : {}),
		...(prefixes.length > 0 ? { prefixes } : {}),
		...(offset + selected.length < ordered.length
			? { nextPageToken: String(offset + selected.length) }
			: {}),
	});
}

function resource(item: FakeObject) {
	return {
		name: item.name,
		generation: item.generation,
		size: String(item.data.byteLength),
		updated: item.updated,
		etag: item.etag,
		contentType: item.contentType,
		crc32c: `crc-${item.generation}`,
		md5Hash: `md5-${item.generation}`,
	};
}

function media(item: FakeObject, headers: HeadersInit | undefined): Response {
	const range = new Headers(headers).get('range');
	if (!range) {
		return new Response(Buffer.from(item.data), {
			headers: mediaHeaders(item, item.data.byteLength),
		});
	}
	const match = /^bytes=(\d+)-(\d*)$/.exec(range);
	if (!match) return new Response(null, { status: 416 });
	const start = Number(match[1]);
	const end = match[2] ? Number(match[2]) : item.data.byteLength - 1;
	if (start >= item.data.byteLength || end < start) return new Response(null, { status: 416 });
	const boundedEnd = Math.min(end, item.data.byteLength - 1);
	const data = item.data.slice(start, boundedEnd + 1);
	return new Response(Buffer.from(data), {
		status: 206,
		headers: {
			...mediaHeaders(item, data.byteLength),
			'Content-Range': `bytes ${start}-${boundedEnd}/${item.data.byteLength}`,
		},
	});
}

function mediaHeaders(item: FakeObject, length: number): Record<string, string> {
	return {
		'Content-Length': String(length),
		'Content-Type': item.contentType,
		ETag: item.etag,
		'x-goog-generation': item.generation,
	};
}
