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
});

export async function accessToken(
	raw: string,
	probe: IntegrationProbe,
	signal: AbortSignal,
): Promise<string> {
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
		return tokenSchema.parse(await response.json()).access_token;
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof ResourceExhaustedError) throw error;
		throw new UnavailableError(
			'BigQuery authentication failed. Check the service-account credentials.',
		);
	}
}
