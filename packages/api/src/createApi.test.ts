import { afterEach, describe, it, expect, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import {
	ConflictError,
	createServices,
	ForbiddenError,
	NotFoundError,
	NotInitializedError,
	PreconditionFailedError,
	UnavailableError,
} from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectPage } from './testing';

afterEach(() => {
	vi.restoreAllMocks();
});

// Each row drives exactly one branch of the real `createApi` onError handler.
// The message is the class name so the snapshot stays readable and deterministic.
const CASES = [
	{ name: 'NotFoundError', make: () => new NotFoundError('NotFoundError') },
	{ name: 'ForbiddenError', make: () => new ForbiddenError('ForbiddenError') },
	{ name: 'ConflictError', make: () => new ConflictError('ConflictError') },
	{
		name: 'PreconditionFailedError',
		make: () => new PreconditionFailedError('PreconditionFailedError'),
	},
	{ name: 'NotInitializedError', make: () => new NotInitializedError('NotInitializedError') },
	{ name: 'UnavailableError', make: () => new UnavailableError('UnavailableError') },
	// Fallthrough: an unexpected error is mapped to a generic 500 (no detail leaks).
	{ name: 'Error', make: () => new Error('boom') },
] as const;

describe('createApi onError mapping', () => {
	it('maps domain errors to response envelopes', async () => {
		const table = [];
		for (const c of CASES) {
			// A fresh app per case so the `/_throw` route never collides.
			const { app } = createTestApi();
			app.get('/_throw', () => {
				throw c.make();
			});
			const res = await app.request('/_throw');
			table.push({ thrown: c.name, status: res.status, body: await res.json() });
		}
		expect(table).toMatchSnapshot();
	});

	// A thrown HTTPException carries its own Response; onError must honor it rather
	// than swallowing it into a generic 500.
	it('honors a thrown HTTPException instead of masking it as a 500', async () => {
		const { app } = createTestApi();
		app.get('/_throw', () => {
			throw new HTTPException(418, { message: "I'm a teapot" });
		});
		const res = await app.request('/_throw');
		expect(res.status).toBe(418);
		expect(await res.text()).toContain('teapot');
	});

	it('sanitizes and logs a 5xx HTTPException', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { app } = createTestApi();
		app.get('/_throw', () => {
			throw new HTTPException(503, { message: 'upstream secret do-not-return' });
		});

		const res = await app.request('/_throw');
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			success: false,
			error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
		});
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]?.[0]).toContain('request_error');
		expect(log.mock.calls[0]?.[0]).not.toContain('do-not-return');
	});
});

describe('createApi identity refresh is best-effort', () => {
	it('serves an authenticated request even when identities.upsert throws', async () => {
		const bucket = await createInitializedBucket();
		const services = createServices(bucket);
		// The best-effort identity-directory refresh must never 500 a request.
		vi.spyOn(services.identities, 'upsert').mockRejectedValue(new Error('directory down'));

		const { request } = createTestApi({ bucket, deps: { services } });
		const res = await request('GET', '/projects');
		expect(await expectPage(res)).toEqual([]);
	});
});

describe('createApi suspended-user enforcement', () => {
	it('rejects every authenticated API route before identity upsert and restores access on reactivation', async () => {
		const bucket = await createInitializedBucket();
		const { request, deps } = createTestApi({ bucket });
		await deps.services.identities.upsert({
			id: ACTOR,
			email: `${ACTOR}@example.com`,
			name: 'Suspended User',
		});
		await deps.services.identities.setSuspension(ACTOR, true);
		const upsert = vi.spyOn(deps.services.identities, 'upsert');

		for (const path of ['/me', '/projects', '/admin/users']) {
			await expectError(await request('GET', path), 403, 'USER_SUSPENDED');
		}
		expect(upsert).not.toHaveBeenCalled();
		expect((await deps.services.identities.get(ACTOR))?.suspended_at).toBeTruthy();

		await deps.services.identities.setSuspension(ACTOR, false);
		expect(await request('GET', '/me')).toHaveProperty('status', 200);
	});

	it('fails closed when suspension status cannot be verified', async () => {
		const bucket = await createInitializedBucket();
		const services = createServices(bucket);
		vi.spyOn(services.identities, 'isSuspended').mockRejectedValue(
			new UnavailableError('Unable to verify account suspension status'),
		);

		const { request } = createTestApi({ bucket, deps: { services } });
		await expectError(await request('GET', '/projects'), 503, 'SERVICE_UNAVAILABLE');
	});

	// The deep health probe authenticates outside the `/api/v1/*` guard, so it must
	// enforce suspension on its own (the shallow probe stays unauthenticated).
	it('rejects a suspended user from the deep health probe', async () => {
		const bucket = await createInitializedBucket();
		const { app, deps } = createTestApi({ bucket });
		await deps.services.identities.upsert({
			id: ACTOR,
			email: `${ACTOR}@example.com`,
			name: 'Suspended User',
		});
		await deps.services.identities.setSuspension(ACTOR, true);

		await expectError(await app.request('/api/health?deep=true'), 403, 'USER_SUSPENDED');
		// The shallow probe never touches auth, so it stays reachable.
		expect((await app.request('/api/health')).status).toBe(200);
	});
});

describe('createApi CSRF guard', () => {
	async function postProject(
		headers: Record<string, string>,
		policy: { allowedOrigins?: string[] } = {},
	) {
		const bucket = await createInitializedBucket();
		return createTestApi({ bucket, deps: { policy } }).request(
			'POST',
			'/projects',
			{ name: 'Project', description: '' },
			headers,
		);
	}

	it('rejects null origins and reverse-proxy host rewriting unless explicitly allowlisted', async () => {
		expect((await postProject({ origin: 'null' })).status).toBe(403);
		expect(
			(
				await postProject({
					origin: 'https://public.example',
					host: 'internal.example:3000',
				})
			).status,
		).toBe(403);
		expect(
			(
				await postProject(
					{
						origin: 'https://public.example',
						host: 'internal.example:3000',
					},
					{ allowedOrigins: ['https://public.example'] },
				)
			).status,
		).toBe(201);
	});

	it('fails closed when Origin and Fetch Metadata conflict', async () => {
		expect(
			(
				await postProject({
					origin: 'http://localhost',
					'sec-fetch-site': 'cross-site',
				})
			).status,
		).toBe(403);
		expect(
			(
				await postProject({
					origin: 'https://evil.example',
					'sec-fetch-site': 'same-origin',
				})
			).status,
		).toBe(403);
	});
});
