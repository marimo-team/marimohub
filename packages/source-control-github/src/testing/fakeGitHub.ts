import { generateKeyPairSync } from 'node:crypto';
import { expect } from 'vitest';

let privateKey: string | undefined;

/** A GitHub App private key, generated once per test file because RSA keygen is slow. */
export function testPrivateKey(): string {
	privateKey ??= generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ type: 'pkcs8', format: 'pem' })
		.toString();
	return privateKey;
}

export function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * Asserts a request targets the API for `origin` and returns it with the GHES
 * `/api/v3` (or `/api/graphql`) prefix stripped, so routes match github.com paths.
 */
export function parseApiRequest(url: string, origin: string): URL {
	const parsed = new URL(url);
	expect(parsed.origin).toBe(origin === 'https://github.com' ? 'https://api.github.com' : origin);
	if (origin !== 'https://github.com') {
		if (parsed.pathname.endsWith('/graphql')) {
			expect(parsed.pathname).toBe('/api/graphql');
		} else {
			expect(parsed.pathname.startsWith('/api/v3/')).toBe(true);
		}
		parsed.pathname = parsed.pathname
			.replace(/^\/api\/v3/, '')
			.replace(/^\/api\/graphql$/, '/graphql');
	}
	return parsed;
}
