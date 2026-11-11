import {
	readResponseBytes as readBoundedResponse,
	ResponseBodyError,
} from '@marimo-hub/core/response-body';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	UnavailableError,
	ValidationError,
} from '@marimo-hub/core/errors';
import type { DomainError } from '@marimo-hub/core/errors';

export type ProviderHttpError = DomainError & {
	providerStatus: number;
	retryAfterSeconds?: number;
};

export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		return Number.isSafeInteger(seconds) ? seconds : undefined;
	}
	const date = Date.parse(trimmed);
	return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

export function providerHttpError(
	provider: string,
	status: number,
	options: { headers?: Headers; conflictMessage?: string } = {},
): ProviderHttpError {
	let error: DomainError;
	if (status === 400) error = new BadRequestError(`${provider} rejected the request`);
	else if (status === 401 || status === 403)
		error = new ForbiddenError(`${provider} access was denied`);
	else if (status === 404)
		error = new NotFoundError(`${provider} repository, branch, or object was not found`);
	else if (status === 409 || status === 412)
		error = new ConflictError(
			options.conflictMessage ?? `${provider} rejected a conflicting change`,
		);
	else if (status === 422) error = new ValidationError(`${provider} rejected the request`);
	else if (status === 429) error = new UnavailableError(`${provider} rate limit exceeded`);
	else error = new UnavailableError(`${provider} request failed with status ${status}`);
	const retryAfter =
		status === 429 || status >= 500
			? retryAfterSeconds(options.headers?.get('retry-after') ?? null)
			: undefined;
	return Object.assign(error, {
		providerStatus: status,
		...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
	});
}

export function responseFields(provider: string) {
	function record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new UnavailableError(`Invalid ${provider} response`);
		return value as Record<string, unknown>;
	}
	function stringField(value: unknown, key: string): string {
		const field = record(value)[key];
		if (typeof field !== 'string' || !field)
			throw new UnavailableError(`Invalid ${provider} ${key}`);
		return field;
	}
	return { record, stringField };
}

export async function readResponseBytes(
	response: Response,
	limit: number,
	provider: string,
	signal?: AbortSignal | null,
): Promise<Uint8Array> {
	try {
		return await readBoundedResponse(response, limit, signal ?? undefined);
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof ResponseBodyError) {
			if (error.reason === 'too_large')
				throw new BadRequestError(`${provider} response exceeds the size limit`);
			throw new UnavailableError(`${provider} returned an empty response`);
		}
		if (error instanceof BadRequestError) throw error;
		throw new UnavailableError(`${provider} response could not be read`, { cause: error });
	}
}
