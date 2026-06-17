/**
 * Domain errors. Each carries the response `code` and HTTP `status` it maps to,
 * so the API's error handler is a single `instanceof DomainError` check instead
 * of a per-type if-ladder, and adding an error never touches the API layer.
 */
export abstract class DomainError extends Error {
	/** Stable, machine-readable code surfaced in the API error envelope. */
	abstract readonly code: string;
	/** HTTP status this error maps to. */
	abstract readonly status: number;
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
	constructor(message = 'Conflict') {
		super(message);
		this.name = 'ConflictError';
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
	constructor(message = 'Service unavailable') {
		super(message);
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
