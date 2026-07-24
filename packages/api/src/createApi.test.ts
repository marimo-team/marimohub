import { describe, it, expect, vi } from 'vitest';
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
import { createInitializedBucket, createTestApi, expectPage } from './testing';

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
