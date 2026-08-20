import { expect } from 'vitest';
import { CatalogService, createServices } from '@marimo-hub/core';
import type {
	Authenticator,
	SandboxProvider,
	SourceControlPublisher,
	SourceControlReader,
	SourceControlRegistry,
	UserId,
} from '@marimo-hub/core';
import { ACTOR, MemoryBucket, noopCompute } from '@marimo-hub/core/testing';
import type { ApiDeps } from '../context';
import { createApi } from '../createApi';

/**
 * Build the `ApiDeps` bundle every API test needs. Defaults to a no-op compute
 * and a deny-all authenticator; `overrides` swaps in a `compute`/`authenticator`
 * (or anything else) per test.
 */
export function makeTestDeps(bucket: MemoryBucket, overrides: Partial<ApiDeps> = {}): ApiDeps {
	return {
		services: createServices(bucket),
		bucket,
		compute: noopCompute,
		authenticator: { authenticate: async () => null },
		// Alive by default so reused sessions resume; override per test for the dead path.
		kernelProbe: async () => 'alive',
		sandbox: {
			bucket: { name: 'test', endpoint: '' },
			hostname: 'localhost',
			workdir: '/workspace',
			persistWorkspace: 'source',
		},
		policy: {},
		...overrides,
	};
}

/**
 * A `SourceControlRegistry` serving the given publisher and/or reader under
 * their own provider ids — the deps stub for change-request and sync tests.
 */
export function stubSourceControl(
	options: { publisher?: SourceControlPublisher; reader?: SourceControlReader } = {},
): SourceControlRegistry {
	const { publisher, reader } = options;
	return {
		getPublisher: (provider) => (provider === publisher?.provider ? publisher : undefined),
		getReader: (provider) => (provider === reader?.provider ? reader : undefined),
		publisherProviders: () => (publisher ? [publisher.provider] : []),
		readerProviders: () => (reader ? [reader.provider] : []),
	};
}

/** A `MemoryBucket` with the catalog initialized (no default project seeded). */
export async function createInitializedBucket(): Promise<MemoryBucket> {
	const bucket = new MemoryBucket();
	await new CatalogService(bucket).initialize(ACTOR);
	return bucket;
}

export interface TestApiOptions {
	/** Shared bucket — pass one to seed fixtures or wire multiple users together. */
	bucket?: MemoryBucket;
	/** The id the stub authenticator returns for every request. Defaults to ACTOR. */
	userId?: UserId;
	/** Compute provider — defaults to `noopCompute`. */
	compute?: SandboxProvider;
	/** Per-user concurrent-session cap to wire into deps (default: unlimited). */
	maxConcurrentSessionsPerUser?: number;
	/** Arbitrary extra `ApiDeps` overrides (e.g. WIF issuer/broker) merged last. */
	deps?: Partial<ApiDeps>;
}

/**
 * Spin up the REAL `createApi` app over a `MemoryBucket`, authenticated as
 * `userId`. Because it's the production app, the real `onError` mapping, auth
 * guard, and auto-init middleware are all exercised — no mirrored handler to
 * drift. `request` prepends the `/api/v1` mount prefix so callers write paths like
 * `/projects/{pid}`.
 */
export function createTestApi(options: TestApiOptions = {}) {
	const bucket = options.bucket ?? new MemoryBucket();
	const userId = options.userId ?? ACTOR;
	const authenticator: Authenticator = {
		authenticate: async () => ({ id: userId, email: `${userId}@example.com` }),
	};
	const deps = makeTestDeps(bucket, {
		authenticator,
		...(options.compute ? { compute: options.compute } : {}),
		...(options.maxConcurrentSessionsPerUser !== undefined
			? { policy: { maxConcurrentSessionsPerUser: options.maxConcurrentSessionsPerUser } }
			: {}),
		...options.deps,
	});
	const app = createApi(deps);

	function request(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
		const init: RequestInit = { method };
		const h: Record<string, string> = { ...headers };
		if (body) {
			h['Content-Type'] = 'application/json';
			init.body = JSON.stringify(body);
		}
		if (Object.keys(h).length > 0) init.headers = h;
		return app.request(`/api/v1${path}`, init);
	}

	return { app, bucket, deps, request };
}

/**
 * Assert a `{ success: true, data }` envelope at `status` (default 200) and
 * return `data`.
 */
export async function expectOk<T = any>(res: Response, status = 200): Promise<T> {
	expect(res.status).toBe(status);
	const json = (await res.json()) as { success: boolean; data: T };
	expect(json.success).toBe(true);
	return json.data;
}

/**
 * Assert a paginated `{ success, data: { items, next_cursor } }` envelope and
 * return the `items` array.
 */
export async function expectPage<T = any>(res: Response, status = 200): Promise<T[]> {
	const data = await expectOk<{ items: T[]; next_cursor: string | null }>(res, status);
	return data.items;
}

/**
 * Assert a `{ success: false, error }` envelope at `status`, optionally checking
 * `error.code`. Returns the error object.
 */
export async function expectError(res: Response, status: number, code?: string): Promise<any> {
	expect(res.status).toBe(status);
	const json = (await res.json()) as { success: boolean; error: { code: string } };
	expect(json.success).toBe(false);
	if (code) expect(json.error.code).toBe(code);
	return json.error;
}
