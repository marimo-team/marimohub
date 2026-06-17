import { expect } from 'vitest';
import {
	type Authenticator,
	CatalogService,
	createServices,
	type SandboxProvider,
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
		sandboxBucket: { name: 'test', endpoint: '' },
		sandboxHostname: 'localhost',
		...overrides,
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
	userId?: string;
	/** Compute provider — defaults to `noopCompute`. */
	compute?: SandboxProvider;
	/** Per-user concurrent-session cap to wire into deps (default: unlimited). */
	maxConcurrentSessionsPerUser?: number;
}

/**
 * Spin up the REAL `createApi` app over a `MemoryBucket`, authenticated as
 * `userId`. Because it's the production app, the real `onError` mapping, auth
 * guard, and auto-init middleware are all exercised — no mirrored handler to
 * drift. `request` prepends the `/api` mount prefix so callers write paths like
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
			? { maxConcurrentSessionsPerUser: options.maxConcurrentSessionsPerUser }
			: {}),
	});
	const app = createApi(deps);

	function request(method: string, path: string, body?: unknown) {
		const init: RequestInit = { method };
		if (body) {
			init.headers = { 'Content-Type': 'application/json' };
			init.body = JSON.stringify(body);
		}
		return app.request(`/api${path}`, init);
	}

	return { app, bucket, deps, request };
}

/**
 * Assert a `{ success: true, data }` envelope at `status` (default 200) and
 * return `data`.
 */
export async function expectOk<T = any>(res: Response, status = 200): Promise<T> {
	expect(res.status).toBe(status);
	const json = (await res.json()) as any;
	expect(json.success).toBe(true);
	return json.data as T;
}

/**
 * Assert a `{ success: false, error }` envelope at `status`, optionally checking
 * `error.code`. Returns the error object.
 */
export async function expectError(res: Response, status: number, code?: string): Promise<any> {
	expect(res.status).toBe(status);
	const json = (await res.json()) as any;
	expect(json.success).toBe(false);
	if (code) expect(json.error.code).toBe(code);
	return json.error;
}
