export class PreconditionFailedError extends Error {
	readonly status = 412;
	constructor(message = 'Precondition failed') {
		super(message);
		this.name = 'PreconditionFailedError';
	}
}

export class NotFoundError extends Error {
	readonly status = 404;
	constructor(message = 'Not found') {
		super(message);
		this.name = 'NotFoundError';
	}
}

export class ConflictError extends Error {
	readonly status = 409;
	constructor(message = 'Conflict') {
		super(message);
		this.name = 'ConflictError';
	}
}

export class ForbiddenError extends Error {
	readonly status = 403;
	constructor(message = 'Forbidden') {
		super(message);
		this.name = 'ForbiddenError';
	}
}

/** Storage exists but the catalog/snapshot has not been initialized yet. */
export class NotInitializedError extends Error {
	readonly status = 409;
	constructor(message = 'Not initialized') {
		super(message);
		this.name = 'NotInitializedError';
	}
}

/** An external dependency (compute/storage) is unavailable — transient. */
export class UnavailableError extends Error {
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
export class ResourceExhaustedError extends Error {
	readonly status = 429;
	constructor(message = 'Resource limit exceeded') {
		super(message);
		this.name = 'ResourceExhaustedError';
	}
}
