import { beforeEach, describe, expect, it, vi } from 'vitest';

const joseMock = vi.hoisted(() => ({
	importPKCS8: vi.fn(),
	sign: vi.fn(),
}));

vi.mock('jose', () => ({
	importPKCS8: joseMock.importPKCS8,
	SignJWT: class MockSignJWT {
		constructor(private readonly payload: unknown) {}

		setProtectedHeader(): this {
			return this;
		}

		setIssuer(): this {
			return this;
		}

		setSubject(): this {
			return this;
		}

		setAudience(): this {
			return this;
		}

		setIssuedAt(): this {
			return this;
		}

		setExpirationTime(): this {
			return this;
		}

		sign(key: unknown): Promise<string> {
			return joseMock.sign({ key, payload: this.payload });
		}
	},
}));

import { bucketContract } from '@marimo-hub/core/testing/contract';
import { GcsStorage, generationParam } from './index';

beforeEach(() => {
	joseMock.importPKCS8.mockReset().mockResolvedValue('mock-private-key');
	joseMock.sign.mockReset().mockResolvedValue('signed-assertion');
});

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

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
	return new Headers(headers).get(name);
}

bucketContract(
	'GcsStorage (in-memory fetch)',
	() => new GcsStorage({ bucket: 'test', fetchImpl: makeFakeGcsFetch() }),
);

describe('GcsStorage auth and request mapping', () => {
	it('sends a bearer token when accessToken is configured', async () => {
		const calls: RequestInit[] = [];
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			calls.push(init ?? {});
			return json({ items: [] });
		});
		const bucket = new GcsStorage({ bucket: 'test', accessToken: 'static-token', fetchImpl });

		await bucket.list();

		expect(headerValue(calls[0]?.headers, 'authorization')).toBe('Bearer static-token');
	});

	it('lets getToken take precedence and omit auth when it returns undefined', async () => {
		const calls: RequestInit[] = [];
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			calls.push(init ?? {});
			return json({ items: [] });
		});
		const getToken = vi.fn(async () => {});
		const bucket = new GcsStorage({
			bucket: 'test',
			accessToken: 'static-token',
			getToken,
			fetchImpl,
		});

		await bucket.list();

		expect(getToken).toHaveBeenCalledOnce();
		expect(headerValue(calls[0]?.headers, 'authorization')).toBeNull();
	});

	it('throws early for malformed service account configuration', () => {
		expect(() => new GcsStorage({ bucket: 'test', serviceAccountKey: '{not-json' })).toThrow();
		expect(
			() =>
				new GcsStorage({
					bucket: 'test',
					serviceAccountKey: JSON.stringify({ client_email: 'x' }),
				}),
		).toThrow(/Invalid GCS service account key/);
	});

	it('mints and caches a service-account token for subsequent requests', async () => {
		const tokenRequests: RequestInit[] = [];
		const storageRequests: RequestInit[] = [];
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://auth.example/token') {
				tokenRequests.push(init ?? {});
				return json({ access_token: 'minted-token', expires_in: 3600 });
			}
			storageRequests.push(init ?? {});
			return json({ items: [] });
		});
		const bucket = new GcsStorage({
			bucket: 'test',
			serviceAccountKey: {
				client_email: 'sa@example.com',
				private_key: 'line1\\nline2',
				token_uri: 'https://auth.example/token',
			},
			fetchImpl,
		});

		await bucket.list();
		await bucket.list();

		expect(joseMock.importPKCS8).toHaveBeenCalledOnce();
		expect(joseMock.importPKCS8).toHaveBeenCalledWith('line1\nline2', 'RS256');
		expect(joseMock.sign).toHaveBeenCalledOnce();
		expect(tokenRequests).toHaveLength(1);
		expect(headerValue(tokenRequests[0]?.headers, 'content-type')).toBe(
			'application/x-www-form-urlencoded',
		);
		expect(String(tokenRequests[0]?.body)).toContain('assertion=signed-assertion');
		expect(storageRequests).toHaveLength(2);
		expect(storageRequests.map((r) => headerValue(r.headers, 'authorization'))).toEqual([
			'Bearer minted-token',
			'Bearer minted-token',
		]);
	});

	it('rejects a failed service-account token exchange', async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
			String(input) === 'https://auth.example/token'
				? new Response('bad credentials', { status: 400 })
				: json({ items: [] }),
		);
		const bucket = new GcsStorage({
			bucket: 'test',
			serviceAccountKey: {
				client_email: 'sa@example.com',
				private_key: 'key',
				token_uri: 'https://auth.example/token',
			},
			fetchImpl,
		});

		await expect(bucket.list()).rejects.toThrow(/GCS token exchange failed: 400 bad credentials/);
	});

	it('rejects a malformed service-account token response', async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
			String(input) === 'https://auth.example/token'
				? json({ expires_in: 3600 })
				: json({ items: [] }),
		);
		const bucket = new GcsStorage({
			bucket: 'test',
			serviceAccountKey: {
				client_email: 'sa@example.com',
				private_key: 'key',
				token_uri: 'https://auth.example/token',
			},
			fetchImpl,
		});

		await expect(bucket.list()).rejects.toThrow(/malformed response/);
	});

	it('uses multipart upload when custom metadata is present', async () => {
		let uploadUrl: URL | undefined;
		let uploadInit: RequestInit | undefined;
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			uploadUrl = new URL(String(input));
			uploadInit = init;
			return json({
				name: 'notebook.py',
				generation: '123',
				size: '8',
				updated: '2025-03-05T14:00:00.000Z',
			});
		});
		const bucket = new GcsStorage({ bucket: 'test', accessToken: 'token', fetchImpl });

		const result = await bucket.put('notebook.py', 'print(1)', {
			httpMetadata: { contentType: 'text/x-python' },
			customMetadata: { source: 'git', revision: 'abc123' },
		});

		expect(result.etag).toBe('123');
		expect(uploadUrl?.pathname).toBe('/upload/storage/v1/b/test/o');
		expect(uploadUrl?.searchParams.get('name')).toBe('notebook.py');
		expect(uploadUrl?.searchParams.get('uploadType')).toBe('multipart');
		expect(headerValue(uploadInit?.headers, 'content-type')).toContain('multipart/related');
		const bodyText = new TextDecoder().decode(uploadInit?.body as Uint8Array);
		expect(bodyText).toContain('"metadata":{"source":"git","revision":"abc123"}');
		expect(bodyText).toContain('Content-Type: text/x-python');
		expect(bodyText).toContain('print(1)');
	});

	it('falls back to metadata lookup when media get omits the generation header', async () => {
		const urls: string[] = [];
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			urls.push(url.toString());
			if (url.searchParams.get('alt') === 'media') {
				return new Response('payload', {
					status: 200,
					headers: {
						'content-length': '7',
						'last-modified': 'Wed, 05 Mar 2025 14:00:00 GMT',
					},
				});
			}
			return json({
				generation: '456',
				size: '7',
				updated: '2025-03-05T14:00:00.000Z',
			});
		});
		const bucket = new GcsStorage({ bucket: 'test', accessToken: 'token', fetchImpl });

		const body = await bucket.get('dir/notebook.py');

		expect(body?.etag).toBe('456');
		expect(await body?.text()).toBe('payload');
		expect(urls[0]).toContain('alt=media');
		expect(new URL(urls[1]).searchParams.get('fields')).toBe('generation,size,updated');
	});

	it('maps list pagination and delimiter parameters', async () => {
		let seenUrl: URL | undefined;
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			seenUrl = new URL(String(input));
			return json({
				items: [
					{
						name: 'runs/a.py',
						generation: '101',
						size: '9',
						updated: '2025-03-05T14:00:00.000Z',
					},
					{ generation: 'ignored' },
				],
				prefixes: ['runs/sub/'],
				nextPageToken: 'next-page',
			});
		});
		const bucket = new GcsStorage({ bucket: 'test', accessToken: 'token', fetchImpl });

		const result = await bucket.list({
			prefix: 'runs/',
			delimiter: '/',
			limit: 25,
			cursor: 'cursor-1',
			startAfter: 'runs/a.ipynb',
		});

		expect(seenUrl?.searchParams.get('prefix')).toBe('runs/');
		expect(seenUrl?.searchParams.get('delimiter')).toBe('/');
		expect(seenUrl?.searchParams.get('maxResults')).toBe('25');
		expect(seenUrl?.searchParams.get('pageToken')).toBe('cursor-1');
		expect(seenUrl?.searchParams.get('startOffset')).toBe('runs/a.ipynb');
		expect(result).toMatchObject({
			objects: [{ key: 'runs/a.py', etag: '101', size: 9 }],
			truncated: true,
			cursor: 'next-page',
			delimitedPrefixes: ['runs/sub/'],
		});
	});

	it('treats delete 404s as success across batches', async () => {
		const deletes: string[] = [];
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'DELETE') {
				deletes.push(new URL(String(input)).pathname);
				return new Response('not found', { status: 404 });
			}
			return json({});
		});
		const bucket = new GcsStorage({ bucket: 'test', accessToken: 'token', fetchImpl });

		await expect(
			bucket.delete(Array.from({ length: 101 }, (_, i) => `k-${i}`)),
		).resolves.toBeUndefined();

		expect(deletes).toHaveLength(101);
		expect(deletes[0]).toBe('/storage/v1/b/test/o/k-0');
		expect(deletes[100]).toBe('/storage/v1/b/test/o/k-100');
	});
});

describe('GcsStorage conditional-write verification', () => {
	it('passes against a store that enforces ifGenerationMatch atomically', async () => {
		const bucket = new GcsStorage({ bucket: 'test', fetchImpl: makeFakeGcsFetch() });

		await expect(bucket.verifyConditionalWrites()).resolves.toBeUndefined();
	});

	it('fails when a store accepts a wrong generation precondition', async () => {
		let generation = 100;
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname.startsWith('/upload/') && init?.method === 'POST') {
				generation += 1;
				return json({
					name: url.searchParams.get('name'),
					generation: String(generation),
					size: '2',
					updated: '2025-03-05T14:00:00.000Z',
				});
			}
			if (init?.method === 'DELETE') return new Response(null, { status: 204 });
			return new Response('not found', { status: 404 });
		});
		const bucket = new GcsStorage({ bucket: 'test', fetchImpl });

		await expect(bucket.verifyConditionalWrites()).rejects.toThrow(
			/GCS target does NOT enforce conditional writes/,
		);
	});
});

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
