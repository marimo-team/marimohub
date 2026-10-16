import { describe, expect, it } from 'vitest';
import { Seconds } from '../../duration';
import { toBase64Url } from '../../internal/base64url';
import { hmacSha256 } from '../../internal/hmac';
import { mintAiSessionToken } from '../ai/aiSessionConfig';
import {
	containerCredentialsEnv,
	mintWifCredentialsToken,
	toContainerCredentialsResponse,
	verifyWifCredentialsToken,
	validateWifCredentialsUrl,
	wifCredentialsDeadline,
	wifCredentialsSubject,
} from './containerCredentials';
import { signHs256Token } from '../../internal/hs256';

const CLAIMS = {
	sessionId: 'sess-0123456789abcdef',
	projectId: 'proj-0123456789abcdef',
	userId: 'u1',
	subject: { email: 'u1@example.com', credential: { kind: 'sso' as const } },
};

describe('WIF credentials token', () => {
	it('round-trips its claims', async () => {
		const token = await mintWifCredentialsToken('secret', CLAIMS);
		expect(await verifyWifCredentialsToken('secret', token)).toEqual(CLAIMS);
	});

	it('rejects a token signed with another secret', async () => {
		const token = await mintWifCredentialsToken('secret', CLAIMS);
		expect(await verifyWifCredentialsToken('other', token)).toBeNull();
	});

	it('rejects an expired token', async () => {
		const issued = Date.parse('2026-01-01T00:00:00Z');
		const token = await mintWifCredentialsToken('secret', CLAIMS, {
			ttlSeconds: Seconds.of(60),
			now: () => issued,
		});
		expect(await verifyWifCredentialsToken('secret', token, () => issued + 61_000)).toBeNull();
	});

	it('expires exactly at the session deadline', async () => {
		const issued = Date.parse('2026-01-01T00:00:00.123Z');
		const deadline = wifCredentialsDeadline(issued);
		const token = await mintWifCredentialsToken('secret', CLAIMS, {
			now: () => issued,
			expiresAt: deadline,
		});
		expect(
			await verifyWifCredentialsToken('secret', token, () => Date.parse(deadline) - 1),
		).toEqual(CLAIMS);
		expect(await verifyWifCredentialsToken('secret', token, () => Date.parse(deadline))).toBeNull();
	});

	it('rounds a fractional deadline down so the token never outlives it', async () => {
		const issued = Date.parse('2026-01-01T00:00:00Z');
		const deadline = '2026-01-01T01:00:00.900Z';
		const token = await mintWifCredentialsToken('secret', CLAIMS, {
			now: () => issued,
			expiresAt: deadline,
		});
		const floored = Date.parse('2026-01-01T01:00:00Z');
		expect(await verifyWifCredentialsToken('secret', token, () => floored - 1)).toEqual(CLAIMS);
		expect(await verifyWifCredentialsToken('secret', token, () => floored)).toBeNull();
	});

	it.each([60, 8 * 24 * 60 * 60])(
		'uses the earlier of an explicit deadline and the seven-day limit (%s seconds)',
		async (seconds) => {
			const issued = Date.parse('2026-01-01T00:00:00Z');
			const token = await mintWifCredentialsToken('secret', CLAIMS, {
				now: () => issued,
				expiresAt: new Date(issued + seconds * 1000).toISOString(),
			});
			const effective = issued + Math.min(seconds, 7 * 24 * 60 * 60) * 1000;
			expect(await verifyWifCredentialsToken('secret', token, () => effective - 1)).toEqual(CLAIMS);
			expect(await verifyWifCredentialsToken('secret', token, () => effective)).toBeNull();
		},
	);

	it('rejects a token whose signed claims were altered', async () => {
		const token = await mintWifCredentialsToken('secret', CLAIMS);
		const other = await mintWifCredentialsToken('secret', { ...CLAIMS, userId: 'another-user' });
		const [header, , signature] = token.split('.');
		const [, payload] = other.split('.');
		expect(
			await verifyWifCredentialsToken('secret', `${header}.${payload}.${signature}`),
		).toBeNull();
	});

	it('rejects an AI session token signed with the same secret', async () => {
		const ai = await mintAiSessionToken('secret', { ...CLAIMS, notebookId: 'nb-0123456789abcdef' });
		expect(await verifyWifCredentialsToken('secret', ai)).toBeNull();
	});

	it('round-trips the launch principal snapshot without volatile credential fields', async () => {
		const subject = wifCredentialsSubject({
			id: 'u1' as never,
			email: 'u1@example.com',
			name: 'U One',
			groups: ['data-team'],
			entitlements: ['default-role:editor'],
			entitlementsExpiresAt: '2026-01-02T00:00:00Z',
			credential: {
				kind: 'personal-access-token',
				id: 'tok-1',
				expiresAt: '2026-01-02T00:00:00Z',
				grant: { actions: '*', projects: '*' },
			},
		});
		expect(subject).toEqual({
			email: 'u1@example.com',
			groups: ['data-team'],
			entitlements: ['default-role:editor'],
			credential: {
				kind: 'personal-access-token',
				id: 'tok-1',
				grant: { actions: '*', projects: '*' },
			},
		});
		const token = await mintWifCredentialsToken('secret', { ...CLAIMS, subject });
		expect((await verifyWifCredentialsToken('secret', token))?.subject).toEqual(subject);
	});

	it.each([undefined, { email: 'x' }, { email: 'x', credential: { kind: 'bogus' } }])(
		'rejects a signed token with an unusable subject %j',
		async (subject) => {
			const encoded = (await mintWifCredentialsToken('secret', CLAIMS)).split('.')[1];
			const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as Record<
				string,
				unknown
			>;
			const derived = toBase64Url(
				await hmacSha256('secret', 'marimohub/wif-container-credentials-token/v1'),
			);
			const resigned = await signHs256Token(derived, payload);
			expect(await verifyWifCredentialsToken('secret', resigned)).toEqual(CLAIMS);
			const forged = await signHs256Token(derived, { ...payload, subject });
			expect(await verifyWifCredentialsToken('secret', forged)).toBeNull();
		},
	);

	it('rejects malformed input', async () => {
		expect(await verifyWifCredentialsToken('secret', 'not-a-token')).toBeNull();
		expect(await verifyWifCredentialsToken('secret', 'a.b.!!!')).toBeNull();
	});

	it('rejects a token HMAC-signed with the raw key material', async () => {
		const [header, payload] = (await mintWifCredentialsToken('secret', CLAIMS)).split('.');
		const rawSig = toBase64Url(await hmacSha256('secret', `${header}.${payload}`));
		expect(await verifyWifCredentialsToken('secret', `${header}.${payload}.${rawSig}`)).toBeNull();
	});
});

describe('containerCredentialsEnv', () => {
	it('points the SDK at the endpoint and never injects static keys', () => {
		const env = containerCredentialsEnv(
			'https://hub.example.com/api/wif/v1/credentials',
			'tok',
			'https://s3.example.com',
			'eu-west-1',
		);
		expect(env).toEqual({
			AWS_CONTAINER_CREDENTIALS_FULL_URI: 'https://hub.example.com/api/wif/v1/credentials',
			AWS_CONTAINER_AUTHORIZATION_TOKEN: 'tok',
			AWS_ENDPOINT_URL_S3: 'https://s3.example.com',
			AWS_REGION: 'eu-west-1',
		});
	});
});

describe('toContainerCredentialsResponse', () => {
	it('always includes Token, empty when the broker issued none', () => {
		expect(
			toContainerCredentialsResponse({
				accessKeyId: 'AK',
				secretAccessKey: 'SK',
				expiration: '2026-01-01T01:00:00.000Z',
			}),
		).toEqual({
			AccessKeyId: 'AK',
			SecretAccessKey: 'SK',
			Token: '',
			Expiration: '2026-01-01T01:00:00.000Z',
		});
	});

	it('maps to the container provider body', () => {
		expect(
			toContainerCredentialsResponse({
				accessKeyId: 'AK',
				secretAccessKey: 'SK',
				sessionToken: 'ST',
				expiration: '2026-01-01T01:00:00.000Z',
			}),
		).toEqual({
			AccessKeyId: 'AK',
			SecretAccessKey: 'SK',
			Token: 'ST',
			Expiration: '2026-01-01T01:00:00.000Z',
		});
	});
});

describe('validateWifCredentialsUrl', () => {
	it.each(['https://hub.example.com', 'https://hub.example.com/prefix/'])('accepts %s', (url) => {
		expect(() => validateWifCredentialsUrl(url)).not.toThrow();
	});
	it.each([
		'',
		'/api/wif/v1/credentials',
		'http://hub.example.com',
		'ftp://hub.example.com',
		'https://user:secret@hub.example.com',
		'https://hub.example.com?x=1',
		'https://hub.example.com/#x',
	])('rejects %s', (url) => {
		expect(() => validateWifCredentialsUrl(url)).toThrow(/HTTPS/);
	});
});
