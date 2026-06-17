import { describe, it, expect } from 'vitest';
import {
	ConflictError,
	ForbiddenError,
	NotFoundError,
	NotInitializedError,
	PreconditionFailedError,
	UnavailableError,
} from '@marimo-hub/core';
import { createTestApi } from './testing';

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
});
