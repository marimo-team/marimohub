import { describe, it, expect } from 'vitest';
import { bucketContract } from '@marimo-hub/core/testing/contract';
import { GcsStorage, generationParam } from './index';

describe('generationParam', () => {
	it('passes through a numeric generation', () => {
		expect(generationParam('1680000000000000')).toBe('1680000000000000');
	});
	it('coerces a non-numeric (bogus) etag to "1" so it deterministically mismatches', () => {
		expect(generationParam('definitely-not-the-etag')).toBe('1');
		expect(generationParam('')).toBe('1');
	});
});

/**
 * Hermetic contract run: an in-memory `fetch` that speaks just enough of the GCS
 * JSON API (media + multipart upload with `ifGenerationMatch`, media/metadata get,
 * delete, list) to exercise the adapter against the SHARED bucket contract —
 * including the CAS-under-contention cases. The handler does its read-compare-write
 * with NO `await`, so JS run-to-completion makes each request atomic (exactly one
 * concurrent CAS winner), which is what those contract tests assert.
 */
function makeFakeGcsFetch(): typeof fetch {
	const store = new Map<string, { content: Uint8Array; generation: number; updated: string }>();
	let genCounter = 1000;

	// Locate a byte subsequence (used to carve the media part out of a multipart body).
	const indexOfBytes = (hay: Uint8Array, needle: Uint8Array, from = 0): number => {
		outer: for (let i = from; i <= hay.length - needle.length; i++) {
			for (let j = 0; j < needle.length; j++) {
				if (hay[i + j] !== needle[j]) continue outer;
			}
			return i;
		}
		return -1;
	};

	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === 'string' ? input : input.toString());
		const method = (init?.method ?? 'GET').toUpperCase();
		const q = url.searchParams;
		const isUpload = url.pathname.startsWith('/upload/');
		const oIndex = url.pathname.indexOf('/o/');
		const key = oIndex >= 0 ? decodeURIComponent(url.pathname.slice(oIndex + 3)) : undefined;
		const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json', ...headers },
			});
		// The adapter sends bodies as raw bytes (string or Uint8Array). Normalize.
		const bodyBytes = (): Uint8Array => {
			const b = init?.body;
			if (b instanceof Uint8Array) return b;
			if (typeof b === 'string') return new TextEncoder().encode(b);
			return new Uint8Array(0);
		};

		// Upload (media or multipart): POST /upload/.../o?name=KEY[&ifGenerationMatch=G]
		if (isUpload && method === 'POST') {
			const name = q.get('name')!;
			const cond = q.get('ifGenerationMatch');
			const existing = store.get(name);
			if (cond !== null) {
				const want = Number(cond);
				const have = existing?.generation ?? 0;
				if (want !== have) return new Response('precondition failed', { status: 412 });
			}
			// Extract the body (multipart wraps the media between the second blank line
			// and the closing boundary; media is the raw body) — all at the byte level
			// so binary payloads survive.
			let content = bodyBytes();
			if (q.get('uploadType') === 'multipart') {
				const sep = new TextEncoder().encode('\r\n\r\n');
				const first = indexOfBytes(content, sep);
				const second = first >= 0 ? indexOfBytes(content, sep, first + sep.length) : -1;
				if (second >= 0) {
					let media = content.subarray(second + sep.length);
					// Drop the trailing `\r\n--<boundary>--`.
					const closing = new TextEncoder().encode('\r\n--');
					const closeIdx = indexOfBytes(media, closing);
					if (closeIdx >= 0) media = media.subarray(0, closeIdx);
					content = new Uint8Array(media);
				}
			}
			const generation = ++genCounter;
			const updated = new Date(generation).toISOString();
			store.set(name, { content, generation, updated });
			return json({ name, generation: String(generation), size: String(content.length), updated });
		}

		// List: GET /storage/v1/b/BUCKET/o?prefix=&delimiter=
		if (method === 'GET' && oIndex < 0 && url.pathname.endsWith('/o')) {
			const prefix = q.get('prefix') ?? '';
			const items = [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([k, v]) => ({
					name: k,
					generation: String(v.generation),
					size: String(v.content.length),
					updated: v.updated,
				}));
			return json({ items });
		}

		if (key === undefined) return new Response('not found', { status: 404 });
		const obj = store.get(key);

		if (method === 'GET') {
			if (!obj) return new Response('not found', { status: 404 });
			if (q.get('alt') === 'media') {
				return new Response(new Uint8Array(obj.content), {
					status: 200,
					headers: {
						'x-goog-generation': String(obj.generation),
						'content-length': String(obj.content.length),
						'last-modified': new Date(obj.updated).toUTCString(),
					},
				});
			}
			return json({
				generation: String(obj.generation),
				size: String(obj.content.length),
				updated: obj.updated,
			});
		}

		if (method === 'DELETE') {
			if (!obj) return new Response('not found', { status: 404 });
			store.delete(key);
			return new Response(null, { status: 204 });
		}

		return new Response('unhandled', { status: 500 });
	}) as typeof fetch;
}

bucketContract(
	'GcsStorage (in-memory fetch)',
	() => new GcsStorage({ bucket: 'test', fetchImpl: makeFakeGcsFetch() }),
);

// Live contract: runs only against a real GCS bucket (or a fake-gcs-server
// emulator). Set MARIMOHUB_TEST_GCS_BUCKET and either MARIMOHUB_TEST_GCS_TOKEN or
// MARIMOHUB_TEST_GCS_SA_KEY (and MARIMOHUB_TEST_GCS_ENDPOINT for the emulator).
const liveBucket = process.env.MARIMOHUB_TEST_GCS_BUCKET;
if (liveBucket) {
	bucketContract(
		'GcsStorage (live)',
		() =>
			new GcsStorage({
				bucket: liveBucket,
				apiEndpoint: process.env.MARIMOHUB_TEST_GCS_ENDPOINT,
				accessToken: process.env.MARIMOHUB_TEST_GCS_TOKEN,
				serviceAccountKey: process.env.MARIMOHUB_TEST_GCS_SA_KEY,
			}),
	);
} else {
	describe.skip('GcsStorage live contract', () => {
		it('set MARIMOHUB_TEST_GCS_BUCKET to run against real GCS / an emulator', () => {});
	});
}
