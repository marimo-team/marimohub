import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { StaleWhileRevalidateCache } from '@marimo-hub/core/cache';
import { ResourceExhaustedError, UnavailableError, ValidationError } from '@marimo-hub/core/errors';
import type { IntegrationProbe } from '@marimo-hub/core/ports/integrations';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const accountSchema = z.object({
	type: z.literal('service_account'),
	client_email: z.string().min(1),
	private_key: z.string().min(1),
	token_uri: z.literal(TOKEN_URL).optional(),
});
const tokenSchema = z.object({
	access_token: z
		.string()
		.min(1)
		.regex(/^[^\r\n]+$/),
	expires_in: z.number().int().positive().max(86_400),
});

const TOKEN_REFRESH_MARGIN_MS = 60_000;

class SharedFetchAbortedError extends Error {
	override readonly name = 'SharedFetchAbortedError';
}

interface CachedToken {
	token: string;
	expiresAt: number;
	issuedAt: number;
}

export class BigQueryTokenCache {
	private readonly entries = new StaleWhileRevalidateCache<string, CachedToken>({
		load: () => Promise.reject(new Error('BigQuery tokens load through a per-request loader')),
		maxSize: 100,
		// The cache measures freshness from load time, so `issuedAt` (taken at load completion)
		// turns the absolute expiry into a relative window. A token too close to expiry gets a
		// zero window and is refetched on the next request.
		ttl: (entry) => ({
			freshForMs: Math.max(0, entry.expiresAt - TOKEN_REFRESH_MARGIN_MS - entry.issuedAt),
			staleForMs: 0,
		}),
	});

	async get(raw: string, probe: IntegrationProbe, signal: AbortSignal): Promise<string> {
		signal.throwIfAborted();
		const key = await credentialKey(raw);
		signal.throwIfAborted();
		const load = async (): Promise<CachedToken> => {
			const requestedAt = Date.now();
			let result: Awaited<ReturnType<typeof accessToken>>;
			try {
				result = await accessToken(raw, probe, signal);
			} catch (error) {
				if (signal.aborted) throw new SharedFetchAbortedError();
				throw error;
			}
			return {
				token: result.access_token,
				expiresAt: requestedAt + result.expires_in * 1000,
				issuedAt: Date.now(),
			};
		};
		let entry: CachedToken | undefined;
		for (let attempt = 0; entry === undefined; attempt += 1) {
			try {
				entry = await this.entries.get(key, load);
			} catch (error) {
				signal.throwIfAborted();
				// Concurrent callers share one fetch bound to whichever signal started it. Its
				// abort must not fail a caller whose own request is still live.
				if (!(error instanceof SharedFetchAbortedError) || attempt > 0) throw error;
			}
		}
		return entry.token;
	}

	async invalidate(raw: string, token: string): Promise<void> {
		const key = await credentialKey(raw);
		if (this.entries.getIfPresent(key)?.token === token) this.entries.delete(key);
	}
}

async function credentialKey(raw: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function accessToken(
	raw: string,
	probe: IntegrationProbe,
	signal: AbortSignal,
): Promise<z.infer<typeof tokenSchema>> {
	signal.throwIfAborted();
	let account: z.infer<typeof accountSchema>;
	try {
		account = accountSchema.parse(JSON.parse(raw));
	} catch {
		throw new ValidationError(
			'The BigQuery service-account credential is invalid. Use a service-account key with the standard Google token endpoint.',
		);
	}
	try {
		const key = await importPKCS8(account.private_key.replaceAll('\\n', '\n'), 'RS256');
		const assertion = await new SignJWT({
			scope: 'https://www.googleapis.com/auth/bigquery.readonly',
		})
			.setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
			.setIssuer(account.client_email)
			.setAudience(TOKEN_URL)
			.setIssuedAt()
			.setExpirationTime('1h')
			.sign(key);
		signal.throwIfAborted();
		const response = await probe.fetch(TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			signal,
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion,
			}).toString(),
		});
		if (!response.ok) throw new Error('authentication');
		return tokenSchema.parse(await response.json());
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof ResourceExhaustedError) throw error;
		throw new UnavailableError(
			'BigQuery authentication failed. Check the service-account credentials.',
		);
	}
}
