/**
 * Google Cloud Storage `Bucket` adapter (native JSON API over `fetch`).
 *
 * The storage layer's hard requirement (development_docs/architecture.md §3.1) is
 * strong read-after-write consistency PLUS atomic conditional writes. GCS provides
 * this through **object generations**: every write produces a new, monotonic
 * `generation`, and the `ifGenerationMatch` precondition is an atomic
 * compare-and-swap. This adapter therefore maps the `Bucket` port's opaque `etag`
 * onto the GCS **generation** (NOT the resource `etag`/MD5, which `ifGenerationMatch`
 * does not accept):
 *   - `onlyIfEtagMatches` → `ifGenerationMatch=<generation>` (CAS)
 *   - `onlyIfNotExists`    → `ifGenerationMatch=0`            (create-if-absent)
 * A failed precondition (HTTP 412) becomes `PreconditionFailedError`, the exact
 * contract the S3/R2/in-memory adapters honor (`@marimo-hub/core/testing/contract`).
 *
 * We use the JSON API (not GCS's S3-compatible XML shim, whose `If-Match` support
 * is weak) over plain `fetch` — no heavy SDK, so it bundles into the no-node_modules
 * server image and runs unchanged on Workers. Auth is a `jose`-signed
 * service-account JWT exchanged for an access token (cached), or an injected token
 * provider (e.g. the GCE/GKE metadata server) / static token.
 */
import { importPKCS8, SignJWT } from 'jose';
import { ofetch } from 'ofetch';
import type { $Fetch } from 'ofetch';
import { PreconditionFailedError } from '@marimo-hub/core';
import type {
	Bucket,
	BucketListOptions,
	BucketListResult,
	BucketObject,
	BucketObjectBody,
	BucketPutOptions,
} from '@marimo-hub/core/ports';

const DEFAULT_API_ENDPOINT = 'https://storage.googleapis.com';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';

export interface GcsServiceAccountKey {
	client_email: string;
	private_key: string;
	token_uri?: string;
}

/**
 * Parse + validate a service-account key JSON string at the trust boundary.
 * These are credentials, so a malformed value must fail loudly here rather than
 * surface later as an opaque JWT-signing error. (Storage adapters stay free of a
 * schema dependency, so this is a hand-rolled guard.)
 */
function parseServiceAccountKey(raw: string): GcsServiceAccountKey {
	const parsed: unknown = JSON.parse(raw);
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		typeof (parsed as GcsServiceAccountKey).client_email !== 'string' ||
		typeof (parsed as GcsServiceAccountKey).private_key !== 'string'
	) {
		throw new Error(
			'Invalid GCS service account key: expected JSON with string client_email and private_key',
		);
	}
	return parsed as GcsServiceAccountKey;
}

export interface GcsStorageConfig {
	/** Bucket name. */
	bucket: string;
	/** JSON API base URL. Override for the emulator (`STORAGE_EMULATOR_HOST`). */
	apiEndpoint?: string;
	/** OAuth2 scope minted tokens request. Default read+write on storage. */
	scope?: string;
	/** Static access token (simplest; also handy for tests). */
	accessToken?: string;
	/**
	 * Service-account key (the parsed JSON or its string form, e.g. straight from
	 * an env var). Used to mint + cache access tokens via a signed JWT. Newline
	 * escapes in `private_key` are tolerated.
	 */
	serviceAccountKey?: string | GcsServiceAccountKey;
	/**
	 * Injected token provider — the test seam and the hook for alternative auth
	 * (e.g. the GCE/GKE metadata server). Takes precedence over the other modes.
	 * Returning undefined sends no Authorization header (emulator).
	 */
	getToken?: () => Promise<string | undefined>;
	/** Injected fetch (test seam). Defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
}

/** GCS generations are int64s; a non-numeric (bogus) etag can never match a real
 * one, so coerce it to `1` — which yields a deterministic 412 (mismatch) rather
 * than a 400 (invalid precondition). Real generations are microsecond timestamps,
 * never 1, so this is safe. */
export function generationParam(etag: string): string {
	return /^\d+$/.test(etag) ? etag : '1';
}

/** Object name as a single path segment (slashes percent-encoded). */
function encodeObjectName(key: string): string {
	return encodeURIComponent(key);
}

interface GcsObjectResource {
	name?: string;
	generation?: string;
	size?: string;
	updated?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

export class GcsStorage implements Bucket {
	private readonly bucket: string;
	private readonly apiEndpoint: string;
	private readonly scope: string;
	/**
	 * `ofetch` over the (possibly injected) fetch — adds a request timeout (so a
	 * stuck call can't hang the catalog path) plus a transient-network retry. We
	 * always use `.raw()` so callers get the `Response` back: `ignoreResponseError`
	 * keeps the adapter's explicit status mapping (404 → null, 412 →
	 * PreconditionFailedError) authoritative, and `responseType: 'stream'` means
	 * ofetch never consumes the body the methods read themselves.
	 */
	private readonly client: $Fetch;
	private readonly injectedGetToken?: () => Promise<string | undefined>;
	private readonly staticToken?: string;
	private readonly sa?: GcsServiceAccountKey;
	/** Cached minted token + its (skewed) expiry epoch-ms. */
	private cachedToken?: { token: string; expiresAt: number };

	constructor(config: GcsStorageConfig) {
		this.bucket = config.bucket;
		this.apiEndpoint = (config.apiEndpoint || DEFAULT_API_ENDPOINT).replace(/\/$/, '');
		this.scope = config.scope ?? DEFAULT_SCOPE;
		this.client = ofetch.create(
			{
				// Reads/deletes are idempotent → retry transient network errors. Writes
				// override this to retry: 0 (see `put`); the catalog CAS loop owns
				// retries on the critical write path. Note: with ignoreResponseError,
				// retry covers network errors + timeouts, NOT 5xx status — which keeps
				// the explicit status mapping below authoritative.
				retry: 2,
				retryDelay: 200,
				timeout: 60_000,
				ignoreResponseError: true,
				responseType: 'stream',
			},
			{ fetch: config.fetchImpl ?? fetch },
		);
		this.injectedGetToken = config.getToken;
		this.staticToken = config.accessToken;
		this.sa =
			typeof config.serviceAccountKey === 'string'
				? parseServiceAccountKey(config.serviceAccountKey)
				: config.serviceAccountKey;
	}

	// --- auth ---------------------------------------------------------------

	private async resolveToken(): Promise<string | undefined> {
		if (this.injectedGetToken) return this.injectedGetToken();
		if (this.staticToken) return this.staticToken;
		if (this.sa) return this.mintToken();
		return undefined;
	}

	private async mintToken(): Promise<string> {
		const sa = this.sa!;
		if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
			return this.cachedToken.token;
		}
		const tokenUri = sa.token_uri || DEFAULT_TOKEN_URI;
		const pkcs8 = sa.private_key.replaceAll('\\n', '\n');
		const key = await importPKCS8(pkcs8, 'RS256');
		const assertion = await new SignJWT({ scope: this.scope })
			.setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
			.setIssuer(sa.client_email)
			.setSubject(sa.client_email)
			.setAudience(tokenUri)
			.setIssuedAt()
			.setExpirationTime('1h')
			.sign(key);
		const res = await this.client.raw(tokenUri, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion,
			}),
		});
		if (!res.ok) {
			throw new Error(`GCS token exchange failed: ${res.status} ${await res.text()}`);
		}
		const json: unknown = await res.json();
		if (
			typeof json !== 'object' ||
			json === null ||
			typeof (json as { access_token?: unknown }).access_token !== 'string' ||
			typeof (json as { expires_in?: unknown }).expires_in !== 'number'
		) {
			throw new Error('GCS token exchange returned a malformed response (no access_token)');
		}
		const { access_token, expires_in } = json as { access_token: string; expires_in: number };
		// Refresh a minute early to avoid using a token that expires mid-request.
		this.cachedToken = {
			token: access_token,
			expiresAt: Date.now() + (expires_in - 60) * 1000,
		};
		return this.cachedToken.token;
	}

	private async authHeaders(): Promise<Record<string, string>> {
		const token = await this.resolveToken();
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	// --- helpers ------------------------------------------------------------

	private objectUrl(key: string, query = ''): string {
		return `${this.apiEndpoint}/storage/v1/b/${this.bucket}/o/${encodeObjectName(key)}${query}`;
	}

	private async failNonOk(res: Response, op: string, key: string): Promise<never> {
		throw new Error(`GCS ${op} failed for "${key}": ${res.status} ${await res.text()}`);
	}

	// --- Bucket -------------------------------------------------------------

	async get(key: string): Promise<BucketObjectBody | null> {
		const res = await this.client.raw(this.objectUrl(key, '?alt=media'), {
			headers: await this.authHeaders(),
		});
		if (res.status === 404) return null;
		if (!res.ok) return this.failNonOk(res, 'get', key);

		const bodyBytes = new Uint8Array(await res.arrayBuffer());
		let bodyText: string | undefined;
		const decode = () => (bodyText ??= new TextDecoder().decode(bodyBytes));
		// Real GCS returns the generation in a response header on media downloads;
		// fall back to a metadata lookup if a backend (e.g. an emulator) omits it.
		let generation = res.headers.get('x-goog-generation') ?? '';
		let uploaded = res.headers.get('last-modified');
		if (!generation) {
			const meta = await this.head(key);
			generation = meta?.etag ?? '';
			uploaded = uploaded ?? meta?.uploaded.toISOString() ?? null;
		}
		const size = Number(res.headers.get('content-length') ?? bodyBytes.length);
		return {
			key,
			etag: generation,
			size,
			uploaded: uploaded ? new Date(uploaded) : new Date(),
			text: async () => decode(),
			json: async <T = unknown>() => JSON.parse(decode()) as T,
			bytes: async () => bodyBytes,
		};
	}

	async head(key: string): Promise<BucketObject | null> {
		const res = await this.client.raw(this.objectUrl(key, '?fields=generation,size,updated'), {
			headers: await this.authHeaders(),
		});
		if (res.status === 404) return null;
		if (!res.ok) return this.failNonOk(res, 'head', key);
		const meta = (await res.json()) as GcsObjectResource;
		return {
			key,
			etag: meta.generation ?? '',
			size: Number(meta.size ?? 0),
			uploaded: meta.updated ? new Date(meta.updated) : new Date(),
		};
	}

	async put(
		key: string,
		value: string | Uint8Array,
		options?: BucketPutOptions,
	): Promise<BucketObject> {
		const params = new URLSearchParams({ name: key });
		if (options?.onlyIfEtagMatches !== undefined) {
			params.set('ifGenerationMatch', generationParam(options.onlyIfEtagMatches));
		} else if (options?.onlyIfNotExists) {
			params.set('ifGenerationMatch', '0');
		}

		const valueBytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
		const contentType = options?.httpMetadata?.contentType ?? 'application/octet-stream';
		const auth = await this.authHeaders();
		const base = `${this.apiEndpoint}/upload/storage/v1/b/${this.bucket}/o`;

		let res: Response;
		if (options?.customMetadata && Object.keys(options.customMetadata).length > 0) {
			// Custom metadata requires a multipart/related upload (resource + media).
			// Assemble the body as raw bytes so binary media round-trips intact.
			params.set('uploadType', 'multipart');
			const boundary = 'mh-gcs-boundary-7d3f1c';
			const resource = JSON.stringify({ contentType, metadata: options.customMetadata });
			const encoder = new TextEncoder();
			const preamble = encoder.encode(
				`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${resource}\r\n` +
					`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
			);
			const epilogue = encoder.encode(`\r\n--${boundary}--`);
			const body = new Uint8Array(preamble.length + valueBytes.length + epilogue.length);
			body.set(preamble, 0);
			body.set(valueBytes, preamble.length);
			body.set(epilogue, preamble.length + valueBytes.length);
			res = await this.client.raw(`${base}?${params}`, {
				method: 'POST',
				headers: { ...auth, 'Content-Type': `multipart/related; boundary=${boundary}` },
				body,
				// Don't replay an upload on a network blip — the CAS contract / catalog
				// retry loop owns write retries.
				retry: 0,
			});
		} else {
			params.set('uploadType', 'media');
			// Copy into a freshly-allocated (ArrayBuffer-backed) view so the body type
			// is an unambiguous `BodyInit`.
			const mediaBody = new Uint8Array(valueBytes);
			res = await this.client.raw(`${base}?${params}`, {
				method: 'POST',
				headers: { ...auth, 'Content-Type': contentType },
				body: mediaBody,
				// See above — uploads are not auto-retried.
				retry: 0,
			});
		}

		if (res.status === 412) {
			throw new PreconditionFailedError(`ETag (generation) mismatch for key "${key}"`);
		}
		if (!res.ok) return this.failNonOk(res, 'put', key);
		const meta = (await res.json()) as GcsObjectResource;
		return {
			key,
			etag: meta.generation ?? '',
			size: valueBytes.length,
			uploaded: meta.updated ? new Date(meta.updated) : new Date(),
		};
	}

	async delete(key: string | string[]): Promise<void> {
		const keys = Array.isArray(key) ? key : [key];
		for (const batch of chunk(keys, 100)) {
			await Promise.all(
				batch.map(async (k) => {
					const res = await this.client.raw(this.objectUrl(k), {
						method: 'DELETE',
						headers: await this.authHeaders(),
					});
					// 404 is fine — delete is idempotent.
					if (!res.ok && res.status !== 404) await this.failNonOk(res, 'delete', k);
				}),
			);
		}
	}

	async list(options?: BucketListOptions): Promise<BucketListResult> {
		const params = new URLSearchParams();
		if (options?.prefix) params.set('prefix', options.prefix);
		if (options?.delimiter) params.set('delimiter', options.delimiter);
		if (options?.limit !== undefined) params.set('maxResults', String(options.limit));
		if (options?.cursor) params.set('pageToken', options.cursor);
		// NOTE: GCS `startOffset` is INCLUSIVE, whereas the port's `startAfter` is
		// exclusive — they differ only at the exact boundary key. Pagination uses
		// `cursor` (pageToken), so this matters only for direct `startAfter` callers.
		if (options?.startAfter) params.set('startOffset', options.startAfter);

		const url = `${this.apiEndpoint}/storage/v1/b/${this.bucket}/o?${params}`;
		const res = await this.client.raw(url, { headers: await this.authHeaders() });
		if (!res.ok) return this.failNonOk(res, 'list', options?.prefix ?? '');
		const json = (await res.json()) as {
			items?: GcsObjectResource[];
			prefixes?: string[];
			nextPageToken?: string;
		};

		return {
			objects: (json.items ?? [])
				.filter((o): o is GcsObjectResource & { name: string } => Boolean(o.name))
				.map((o) => ({
					key: o.name,
					etag: o.generation ?? '',
					size: Number(o.size ?? 0),
					uploaded: o.updated ? new Date(o.updated) : new Date(),
				})),
			truncated: Boolean(json.nextPageToken),
			cursor: json.nextPageToken,
			delimitedPrefixes: json.prefixes ?? [],
		};
	}

	/**
	 * Boot self-check (called duck-typed by apps/server): confirm the store applies
	 * conditional writes atomically. Mirrors the S3 adapter's two probes — a
	 * wrong-generation put must be rejected, and concurrent CAS puts from one base
	 * generation must yield at most one winner.
	 */
	async verifyConditionalWrites(): Promise<void> {
		const probeKey = '_system/.cas-probe';

		await this.put(probeKey, 'v1');
		let rejected = false;
		try {
			await this.put(probeKey, 'v2', { onlyIfEtagMatches: 'this-generation-is-wrong' });
		} catch (err) {
			if (!(err instanceof PreconditionFailedError)) {
				await this.delete(probeKey).catch(() => {});
				throw err;
			}
			rejected = true;
		}
		if (!rejected) {
			await this.delete(probeKey).catch(() => {});
			throw new Error(
				'GCS target does NOT enforce conditional writes (ifGenerationMatch): a put with a wrong ' +
					'generation was accepted. The catalog compare-and-swap protocol is unsafe on this store.',
			);
		}

		const seed = await this.put(probeKey, 'v3');
		const N = 8;
		const results = await Promise.allSettled(
			Array.from({ length: N }, (_, i) =>
				this.put(probeKey, `r${i}`, { onlyIfEtagMatches: seed.etag }),
			),
		);
		await this.delete(probeKey).catch(() => {});
		for (const r of results) {
			if (r.status === 'rejected' && !(r.reason instanceof PreconditionFailedError)) throw r.reason;
		}
		const winners = results.filter((r) => r.status === 'fulfilled').length;
		if (winners > 1) {
			throw new Error(
				`GCS target does NOT apply conditional writes atomically: ${winners} concurrent ` +
					'ifGenerationMatch puts from the same generation were accepted (expected at most 1).',
			);
		}
	}
}
