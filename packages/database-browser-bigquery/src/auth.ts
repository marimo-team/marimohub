import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { ResourceExhaustedError, UnavailableError, ValidationError } from '@marimo-hub/core';
import type { IntegrationProbe } from '@marimo-hub/core';

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

export class BigQueryTokenCache {
	private readonly entries = new Map<string, { token: string; expiresAt: number }>();

	async get(raw: string, probe: IntegrationProbe, signal: AbortSignal): Promise<string> {
		signal.throwIfAborted();
		const key = await credentialKey(raw);
		signal.throwIfAborted();
		const now = Date.now();
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now + 60_000) this.entries.delete(key);
		}
		const cached = this.entries.get(key);
		if (cached) {
			this.entries.delete(key);
			this.entries.set(key, cached);
			return cached.token;
		}
		const result = await accessToken(raw, probe, signal);
		signal.throwIfAborted();
		const expiresAt = now + result.expires_in * 1000;
		if (expiresAt > Date.now() + 60_000) {
			if (this.entries.size >= 100) this.entries.delete(this.entries.keys().next().value!);
			this.entries.set(key, { token: result.access_token, expiresAt });
		}
		return result.access_token;
	}

	async invalidate(raw: string, token: string): Promise<void> {
		const key = await credentialKey(raw);
		if (this.entries.get(key)?.token === token) this.entries.delete(key);
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
