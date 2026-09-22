import { sha256Hex } from '@marimo-hub/core/sha256';
import { ValidationError } from '@marimo-hub/core';
import type { Context } from 'hono';
import type { ApiDeps, HonoEnv } from './context';

export async function idempotentCreate<T>(
	c: Context<HonoEnv>,
	routeId: string,
	produce: () => Promise<T>,
): Promise<T> {
	const key = c.req.header('Idempotency-Key');
	if (!key) return produce();
	const scope = requestScope(c, routeId);
	return idempotentOperation(c.get('deps'), scope, key, produce, {
		fingerprint: await requestFingerprint(await c.req.text(), c.req.raw),
		legacyScope: `${c.get('user').id}:${routeId}`,
	});
}

function requestScope(c: Context<HonoEnv>, routeId: string): string {
	const route = routeId.replaceAll(
		/\{([^}]+)\}/g,
		(_, name: string) => c.req.param(name) ?? `{${name}}`,
	);
	return `${c.get('user').id}:${route}`;
}

function hasJsonContentType(request: Request): boolean {
	return (
		request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json'
	);
}

function canonicalJson(body: string): string {
	return JSON.stringify(JSON.parse(body), (_key, value: unknown) => {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
		return Object.fromEntries(
			Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		);
	});
}

function requestFingerprint(body: string, request: Request): Promise<string> {
	return sha256Hex(body && hasJsonContentType(request) ? canonicalJson(body) : body);
}

// Authorize before replay lookup. Concurrent first requests can both execute.
export async function idempotentOperation<T>(
	deps: ApiDeps,
	scope: string,
	key: string | undefined,
	produce: () => Promise<T>,
	{ fingerprint, legacyScope }: { fingerprint?: string; legacyScope?: string } = {},
): Promise<T> {
	if (!key) return produce();
	const { idempotency } = deps.services;

	const hit = await idempotency.lookup(scope, key);
	if (hit) {
		if (fingerprint !== undefined) {
			if (hit.fingerprint === undefined) throw legacyKeyError();
			if (hit.fingerprint !== fingerprint) {
				throw new ValidationError(
					'Idempotency-Key was already used with a different request payload',
				);
			}
		}
		return hit.data as T;
	}
	if (legacyScope && legacyScope !== scope && (await idempotency.lookup(legacyScope, key))) {
		throw legacyKeyError();
	}

	const data = await produce();
	await idempotency.record(scope, key, data, fingerprint);
	return data;
}

function legacyKeyError(): ValidationError {
	return new ValidationError(
		'Idempotency-Key predates request validation; check the original operation before using a new key',
	);
}
