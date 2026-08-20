/**
 * Domain errors. Each carries the response `code` and HTTP `status` it maps to,
 * so the API's error handler is a single `instanceof DomainError` check instead
 * of a per-type if-ladder, and adding an error never touches the API layer.
 */
export const DOMAIN_ERROR_CODES = [
	'BAD_REQUEST',
	'PRECONDITION_FAILED',
	'NOT_FOUND',
	'CONFLICT',
	'PROPOSAL_RETRY_REQUIRED',
	'EDIT_SESSION_OWNED',
	'EDIT_SESSION_CHANGED',
	'TAKEOVER_IN_PROGRESS',
	'FORBIDDEN',
	'VALIDATION_ERROR',
	'SYNC_NOT_CONFIGURED',
	'NOT_INITIALIZED',
	'SERVICE_UNAVAILABLE',
	'RESOURCE_EXHAUSTED',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export abstract class DomainError extends Error {
	/** Stable, machine-readable code surfaced in the API error envelope. */
	abstract readonly code: DomainErrorCode;
	/** HTTP status this error maps to. */
	abstract readonly status: number;
	constructor(message?: string, options?: ErrorOptions) {
		super(message, options);
		// Default; concrete subclasses override with their own name. Guarantees a
		// non-`Error` name even if a subclass forgets to set one.
		this.name = 'DomainError';
	}
}

export class BadRequestError extends DomainError {
	readonly code = 'BAD_REQUEST';
	readonly status = 400;
	constructor(message = 'Bad request') {
		super(message);
		this.name = 'BadRequestError';
	}
}

export class PreconditionFailedError extends DomainError {
	readonly code = 'PRECONDITION_FAILED';
	readonly status = 412;
	constructor(message = 'Precondition failed') {
		super(message);
		this.name = 'PreconditionFailedError';
	}
}

export class NotFoundError extends DomainError {
	readonly code = 'NOT_FOUND';
	readonly status = 404;
	constructor(message = 'Not found') {
		super(message);
		this.name = 'NotFoundError';
	}
}

export class ConflictError extends DomainError {
	readonly code = 'CONFLICT';
	readonly status = 409;
	constructor(message = 'Conflict', options?: ErrorOptions) {
		super(message, options);
		this.name = 'ConflictError';
	}
}

export class ProposalRetryRequiredError extends DomainError {
	readonly code = 'PROPOSAL_RETRY_REQUIRED';
	readonly status = 409;
	constructor(message = 'The proposal cannot be resumed; retry with a new idempotency key') {
		super(message);
		this.name = 'ProposalRetryRequiredError';
	}
}

export class EditSessionOwnedError extends DomainError {
	readonly code = 'EDIT_SESSION_OWNED';
	readonly status = 409;
	constructor(message = 'Another editor owns the persistent editing session') {
		super(message);
		this.name = 'EditSessionOwnedError';
	}
}

export class EditSessionChangedError extends DomainError {
	readonly code = 'EDIT_SESSION_CHANGED';
	readonly status = 409;
	constructor(message = 'The editing session changed; refresh before taking over') {
		super(message);
		this.name = 'EditSessionChangedError';
	}
}

export class TakeoverInProgressError extends DomainError {
	readonly code = 'TAKEOVER_IN_PROGRESS';
	readonly status = 409;
	constructor(message = 'An editing-session takeover is already in progress') {
		super(message);
		this.name = 'TakeoverInProgressError';
	}
}

export class ForbiddenError extends DomainError {
	readonly code = 'FORBIDDEN';
	readonly status = 403;
	constructor(message = 'Forbidden') {
		super(message);
		this.name = 'ForbiddenError';
	}
}

/**
 * A value failed a domain-level validation rule (e.g. a malformed or reserved
 * secret name) — distinct from a 400 malformed request in that the request was
 * well-formed but semantically rejected. Maps to HTTP 422.
 */
export class ValidationError extends DomainError {
	readonly code = 'VALIDATION_ERROR';
	readonly status = 422;
	constructor(message = 'Validation failed') {
		super(message);
		this.name = 'ValidationError';
	}
}

/**
 * Server-initiated sync was requested but no configured reader covers the
 * source's provider — the deployment can still receive pushes for it.
 */
export class SyncNotConfiguredError extends DomainError {
	readonly code = 'SYNC_NOT_CONFIGURED';
	readonly status = 409;
	constructor(message = 'Server-initiated sync is not configured for this source') {
		super(message);
		this.name = 'SyncNotConfiguredError';
	}
}

/** Storage exists but the catalog/snapshot has not been initialized yet. */
export class NotInitializedError extends DomainError {
	readonly code = 'NOT_INITIALIZED';
	readonly status = 409;
	constructor(message = 'Not initialized') {
		super(message);
		this.name = 'NotInitializedError';
	}
}

/** An external dependency (compute/storage) is unavailable — transient. */
export class UnavailableError extends DomainError {
	readonly code = 'SERVICE_UNAVAILABLE';
	readonly status = 503;
	constructor(message = 'Service unavailable', options?: ErrorOptions) {
		super(message, options);
		this.name = 'UnavailableError';
	}
}

/**
 * A per-user / per-resource quota was hit (e.g. the concurrent-session cap).
 * Maps to HTTP 429 — the caller should back off or free a resource and retry.
 */
export class ResourceExhaustedError extends DomainError {
	readonly code = 'RESOURCE_EXHAUSTED';
	readonly status = 429;
	constructor(message = 'Resource limit exceeded') {
		super(message);
		this.name = 'ResourceExhaustedError';
	}
}

/**
 * Optimistic-concurrency guard. Throws 412 when an `If-Match` precondition
 * (`expected`, the resource's `updated_at` at read time) no longer matches the
 * resource's `current` version — i.e. it was modified by someone else in between.
 * A no-op when `expected` is undefined (the caller sent no precondition).
 */
export function assertVersionMatch(current: string, expected: string | undefined): void {
	if (expected !== undefined && expected !== current) {
		throw new PreconditionFailedError(
			'Resource was modified since it was last read (If-Match precondition failed)',
		);
	}
}
