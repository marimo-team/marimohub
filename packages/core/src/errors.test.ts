import { describe, it, expect } from 'vitest';
import {
	assertVersionMatch,
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	NotInitializedError,
	PreconditionFailedError,
	ProposalRetryRequiredError,
	ResourceExhaustedError,
	UnavailableError,
	ValidationError,
} from './errors';

// The HTTP status carried by each domain error is load-bearing: `packages/api`
// maps `error.status` straight onto the response code. A silent change to any
// of these numbers would reclassify an error (e.g. a 404 becoming a 409) without
// any route test necessarily noticing, so pin them here.
const CASES = [
	{
		Err: PreconditionFailedError,
		status: 412,
		name: 'PreconditionFailedError',
		def: 'Precondition failed',
	},
	{ Err: NotFoundError, status: 404, name: 'NotFoundError', def: 'Not found' },
	{ Err: ConflictError, status: 409, name: 'ConflictError', def: 'Conflict' },
	{
		Err: ProposalRetryRequiredError,
		status: 409,
		name: 'ProposalRetryRequiredError',
		def: 'The proposal cannot be resumed; retry with a new idempotency key',
	},
	{ Err: ForbiddenError, status: 403, name: 'ForbiddenError', def: 'Forbidden' },
	{ Err: NotInitializedError, status: 409, name: 'NotInitializedError', def: 'Not initialized' },
	{ Err: UnavailableError, status: 503, name: 'UnavailableError', def: 'Service unavailable' },
	{
		Err: ResourceExhaustedError,
		status: 429,
		name: 'ResourceExhaustedError',
		def: 'Resource limit exceeded',
	},
] as const;

describe('domain errors', () => {
	it.each(CASES)('$name is a real Error subclass', ({ Err }) => {
		const e = new Err();
		expect(e).toBeInstanceOf(Error);
		expect(e).toBeInstanceOf(Err);
	});

	it.each(CASES)('$name carries status $status', ({ Err, status }) => {
		expect(new Err().status).toBe(status);
	});

	it.each(CASES)('$name sets name and default message', ({ Err, name, def }) => {
		const e = new Err();
		expect(e.name).toBe(name);
		expect(e.message).toBe(def);
	});

	it.each(CASES)(
		'$name honors a custom message without affecting status/name',
		({ Err, status, name }) => {
			const e = new Err('custom detail');
			expect(e.message).toBe('custom detail');
			expect(e.status).toBe(status);
			expect(e.name).toBe(name);
		},
	);

	it.each(CASES)('$name is catchable as Error and exposes a usable stack', ({ Err }) => {
		expect(() => {
			throw new Err();
		}).toThrow(Error);
		expect(typeof new Err().stack).toBe('string');
	});

	it('BadRequestError carries 400 / BAD_REQUEST and its name', () => {
		const e = new BadRequestError();
		expect(e.status).toBe(400);
		expect(e.code).toBe('BAD_REQUEST');
		expect(e.name).toBe('BadRequestError');
	});

	it('ValidationError carries 422 / VALIDATION_ERROR and its name', () => {
		const e = new ValidationError();
		expect(e.status).toBe(422);
		expect(e.code).toBe('VALIDATION_ERROR');
		expect(e.name).toBe('ValidationError');
	});
});

describe('assertVersionMatch', () => {
	it('is a no-op when the caller sent no precondition (expected undefined)', () => {
		expect(() => assertVersionMatch('etag-1', undefined)).not.toThrow();
	});

	it('passes when expected matches current', () => {
		expect(() => assertVersionMatch('etag-1', 'etag-1')).not.toThrow();
	});

	it('throws PreconditionFailedError on a stale precondition', () => {
		expect(() => assertVersionMatch('etag-2', 'etag-1')).toThrow(PreconditionFailedError);
	});
});
