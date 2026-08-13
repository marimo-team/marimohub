import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core';
import type { GcsObjectStoreSource, ObjectBrowseContext } from '@marimo-hub/core';
import { GcsAuth } from './auth';

const google = vi.hoisted(() => ({
	constructor: vi.fn(),
	getAccessToken: vi.fn(async () => 'adc-token'),
	getProjectId: vi.fn(async () => 'adc-project'),
}));
const originalCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

vi.mock('google-auth-library', () => ({
	GoogleAuth: class {
		constructor(options: unknown) {
			google.constructor(options);
		}

		getAccessToken = google.getAccessToken;
		getProjectId = google.getProjectId;
	},
}));

const source: GcsObjectStoreSource = {
	provider: 'gcs',
	auth: { method: 'ambient' },
};
const context: ObjectBrowseContext = {
	project_id: createProjectId(),
	user_id: UserId.parse('adc-user'),
	user_email: 'adc@example.com',
	allow_server_ambient: { gcs: true },
};

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
	.privateKey.export({ format: 'pem', type: 'pkcs8' })
	.toString();

function serviceAccount(tokenUri = 'https://oauth2.googleapis.com/token'): GcsObjectStoreSource {
	return {
		provider: 'gcs',
		auth: {
			method: 'service_account',
			credentials_json: JSON.stringify({
				client_email: 'browser-reader@example.iam.gserviceaccount.com',
				private_key: privateKey,
				project_id: 'service-project',
				token_uri: tokenUri,
			}),
		},
	};
}

afterEach(() => {
	if (originalCredentialsPath === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
	else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentialsPath;
	google.constructor.mockClear();
	google.getAccessToken.mockClear();
	google.getProjectId.mockClear();
});

describe('GCS ambient authentication', () => {
	it('delegates credential-file ADC types to the standard Google auth flow', async () => {
		process.env.GOOGLE_APPLICATION_CREDENTIALS = '/operator/adc.json';
		const auth = new GcsAuth(source, context, fetch);
		await expect(auth.headers()).resolves.toEqual({ Authorization: 'Bearer adc-token' });
		await expect(auth.projectId()).resolves.toBe('adc-project');
		expect(google.constructor).toHaveBeenCalledWith({
			scopes: 'https://www.googleapis.com/auth/devstorage.read_only',
		});
	});

	it('classifies a deadline timeout as aborted rather than missing credentials', async () => {
		const signal = AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'));
		const auth = new GcsAuth(source, { ...context, signal }, fetch);
		await expect(auth.headers()).rejects.toMatchObject({
			code: 'aborted',
			message: 'The request was canceled.',
		});
	});

	it('classifies a metadata-server timeout as aborted in the pinned-fetch flow', async () => {
		const signal = AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'));
		const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
			throw init?.signal?.reason ?? new Error('unexpected');
		});
		const auth = new GcsAuth(source, { ...context, signal }, fetchImpl, false);
		await expect(auth.headers()).rejects.toMatchObject({
			code: 'aborted',
			message: 'The request was canceled.',
		});
	});
});

describe('GCS service-account authentication', () => {
	it('signs a scoped assertion, exchanges it, and caches the access token', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			Response.json({ access_token: 'service-token', expires_in: 3600 }),
		);
		const auth = new GcsAuth(serviceAccount(), context, fetchImpl);

		await expect(auth.headers()).resolves.toEqual({ Authorization: 'Bearer service-token' });
		await expect(auth.headers()).resolves.toEqual({ Authorization: 'Bearer service-token' });
		await expect(auth.projectId()).resolves.toBe('service-project');
		expect(fetchImpl).toHaveBeenCalledOnce();

		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toBe('https://oauth2.googleapis.com/token');
		expect(init).toMatchObject({
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			signal: context.signal,
		});
		const body = init?.body as URLSearchParams;
		expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
		const assertion = body.get('assertion') ?? '';
		const payload = JSON.parse(
			Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString('utf8'),
		) as Record<string, unknown>;
		expect(payload).toMatchObject({
			iss: 'browser-reader@example.iam.gserviceaccount.com',
			sub: 'browser-reader@example.iam.gserviceaccount.com',
			aud: 'https://oauth2.googleapis.com/token',
			scope: 'https://www.googleapis.com/auth/devstorage.read_only',
		});
	});

	it.each([
		'https://oauth2.googleapis.com.evil.example/token',
		'https://oauth2.googleapis.com/other',
		'http://oauth2.googleapis.com/token',
		'not-a-url',
	])('rejects the unapproved token URI %s before fetching', async (tokenUri) => {
		const fetchImpl = vi.fn<typeof fetch>();
		const auth = new GcsAuth(serviceAccount(tokenUri), context, fetchImpl);

		await expect(auth.headers()).rejects.toMatchObject({
			code: 'access_denied',
			message: 'The GCS token endpoint is not permitted.',
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('maps token endpoint failures without exposing the response', async () => {
		const auth = new GcsAuth(
			serviceAccount(),
			context,
			vi.fn<typeof fetch>(async () => new Response('private provider detail', { status: 403 })),
		);

		await expect(auth.headers()).rejects.toMatchObject({
			code: 'access_denied',
			message: 'GCS authentication failed.',
		});
	});

	it.each([
		['invalid JSON', 'not-json'],
		['null', 'null'],
		['missing private key', JSON.stringify({ client_email: 'reader@example.com' })],
		['missing client email', JSON.stringify({ private_key: privateKey })],
	] as const)(
		'rejects a service-account credential with %s before fetching',
		async (_, credentials) => {
			const fetchImpl = vi.fn<typeof fetch>();
			const auth = new GcsAuth(
				{
					provider: 'gcs',
					auth: { method: 'service_account', credentials_json: credentials },
				},
				context,
				fetchImpl,
			);

			await expect(auth.headers()).rejects.toMatchObject({
				code: 'unavailable',
				message: 'The GCS service-account credential is invalid.',
			});
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it.each([
		{},
		{ access_token: 'service-token' },
		{ access_token: 42, expires_in: 3600 },
		{ access_token: 'service-token', expires_in: '3600' },
	])('rejects the malformed token response %#', async (payload) => {
		const auth = new GcsAuth(
			serviceAccount(),
			context,
			vi.fn<typeof fetch>(async () => Response.json(payload)),
		);

		await expect(auth.headers()).rejects.toMatchObject({
			code: 'access_denied',
			message: 'GCS authentication failed.',
		});
	});
});
