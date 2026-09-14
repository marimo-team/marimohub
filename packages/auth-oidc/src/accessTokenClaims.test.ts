import { describe, expect, it } from 'vitest';
import { principalFromVerifiedAccessToken, parseAccessTokenScopes } from './accessTokenClaims';
import { createAdmissionPolicy } from './admission';

const now = 1700000000;
const policy = {
	audience: 'https://hub.example.com/mcp',
	browserClientId: 'browser',
	maxLifetimeSeconds: 3600,
	admission: createAdmissionPolicy({}),
};
const claims = {
	sub: 'user',
	email: 'user@example.com',
	email_verified: true,
	client_id: 'client',
	aud: policy.audience,
	iat: now,
	exp: now + 300,
	scope: 'marimohub:read',
};
const parse = (overrides: Record<string, unknown> = {}, typ: unknown = 'at+jwt') =>
	principalFromVerifiedAccessToken({ ...claims, ...overrides }, typ, policy, now);

describe('access-token claim boundaries', () => {
	it('accepts the maximum lifetime and rejects one extra second', () => {
		expect(parse({ exp: now + 3600 })).toHaveProperty('principal');
		expect(parse({ exp: now + 3601 })).toEqual({ error: 'invalid_claims' });
	});

	it('accepts a token until its exact expiry', () => {
		expect(parse({ iat: now - 3599, exp: now + 1 })).toHaveProperty('principal');
		expect(parse({ iat: now - 300, exp: now })).toEqual({ error: 'invalid_claims' });
	});

	it.each([
		undefined,
		null,
		'1700000000',
		Number.NaN,
		Infinity,
		-Infinity,
		Number.MAX_SAFE_INTEGER + 1,
		now + 0.5,
	])('rejects invalid numeric dates: %j', (value) => {
		expect(parse({ iat: value })).toEqual({ error: 'invalid_claims' });
		expect(parse({ exp: value })).toEqual({ error: 'invalid_claims' });
	});

	it('rejects future issuance and reversed times', () => {
		expect(parse({ iat: now + 1 })).toEqual({ error: 'invalid_claims' });
		expect(parse({ exp: now, iat: now + 1 })).toEqual({ error: 'invalid_claims' });
	});

	it.each([undefined, 'JWT', 'jwt', 'at+JWT', 'application/AT+JWT'])(
		'accepts the supported token type %j',
		(typ) => {
			expect(principalFromVerifiedAccessToken(claims, typ, policy, now)).toHaveProperty(
				'principal',
			);
		},
	);

	it.each([null, 1, {}, '', 'id+jwt', 'mh-session+jwt', ' at+jwt'])(
		'rejects the token type %j',
		(typ) => {
			expect(parse({}, typ)).toEqual({ error: 'invalid_claims' });
		},
	);

	it.each([null, {}, { jkt: 'key' }, { 'x5t#S256': 'cert' }])(
		'rejects every present confirmation binding: %j',
		(cnf) => {
			expect(parse({ cnf })).toEqual({ error: 'invalid_claims' });
		},
	);

	it('rejects a browser audience even when the resource audience is present', () => {
		expect(parse({ aud: [policy.audience, 'browser'] })).toEqual({ error: 'invalid_claims' });
		expect(parse({ aud: [policy.audience, 'https://other.example.com'] })).toHaveProperty(
			'principal',
		);
	});

	it('deduplicates scopes and unions their action grants without accepting scope prefixes', () => {
		const result = parse({ scope: 'marimohub:read marimohub:run marimohub:read unrelated' });
		expect(result).toMatchObject({
			principal: {
				credential: {
					oauth: { scopes: ['marimohub:read', 'marimohub:run', 'unrelated'] },
					grant: {
						projects: '*',
						actions: [
							'project.read',
							'integration.read',
							'integration.use',
							'session.start',
							'session.attach',
							'session.stop',
							'session.surface',
							'session.proxy',
						],
					},
				},
			},
		});
		for (const scope of ['marimohub:read:extra', 'MARIMOHUB:FULL', 'mcp:tools']) {
			expect(parse({ scope })).toEqual({ error: 'missing_grant_scope' });
		}
	});

	it('does not add bearer powers to identity claims', () => {
		const result = parse({ entitlements: ['super-admin'], name: 'User' });
		expect(result).toHaveProperty('principal');
		if ('principal' in result) {
			expect(result.principal.entitlements).toBeUndefined();
			expect(result.principal.credential.kind).toBe('external-access-token');
		}
	});
});

describe('OAuth scope syntax', () => {
	it.each([
		undefined,
		null,
		[],
		'',
		' ',
		' marimohub:read',
		'marimohub:read ',
		'marimohub:read  mcp:tools',
		'marimohub:read\tmcp:tools',
		'read\n',
		'"read"',
		'read\\write',
		'réad',
		'read\u007f',
		'a'.repeat(8193),
	])('rejects invalid scopes: %j', (value) => {
		expect(parseAccessTokenScopes(value)).toBeNull();
	});
	it('accepts scope punctuation and the maximum encoded length', () => {
		expect(
			parseAccessTokenScopes('! # $ % & ( ) * + , - . / : ; < = > ? @ [ ] ^ _ ` { | } ~'),
		).not.toBeNull();
		expect(parseAccessTokenScopes('a'.repeat(8192))).toEqual(['a'.repeat(8192)]);
	});
});
