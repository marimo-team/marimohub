import { describe, expect, it } from 'vitest';
import { Seconds } from '../../duration';
import { fromBase64Url, utf8ToBase64Url } from '../../internal/base64url';
import { WorkloadIdentityIssuer } from './WorkloadIdentityIssuer';

const RS256_ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

/** Generate an RSA keypair and return the private key as PKCS8 PEM (for the ctor). */
async function generatePkcs8Pem(): Promise<{ pem: string; publicKey: CryptoKey }> {
	const pair = await crypto.subtle.generateKey(
		{ ...RS256_ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		['sign', 'verify'],
	);
	const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
	let bin = '';
	for (const b of der) bin += String.fromCharCode(b);
	const b64 = btoa(bin).replaceAll(/(.{64})/g, '$1\n');
	const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
	return { pem, publicKey: pair.publicKey };
}

function decodeSegment(segment: string): Record<string, unknown> {
	return JSON.parse(new TextDecoder().decode(fromBase64Url(segment))) as Record<string, unknown>;
}

describe('WorkloadIdentityIssuer', () => {
	const claims = {
		iss: 'https://hub.example.com',
		sub: 'proj-abc123',
		aud: 'coreweave-object-storage',
		extraClaims: {
			project_id: 'proj-abc123',
			workload_kind: 'session',
			workload_id: 's_def456',
		},
	};

	it('mints a verifiable RS256 JWT with the expected header and claims', async () => {
		const { pem } = await generatePkcs8Pem();
		const fixedNow = 1_700_000_000_000;
		const issuer = new WorkloadIdentityIssuer(pem, 'kid-1', () => fixedNow);

		const jwt = await issuer.mint(claims);
		const [headerB64, payloadB64, sigB64] = jwt.split('.');

		const header = decodeSegment(headerB64);
		expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });

		const payload = decodeSegment(payloadB64);
		const iat = Math.floor(fixedNow / 1000);
		expect(payload).toMatchObject({
			iss: claims.iss,
			sub: 'proj-abc123',
			aud: 'coreweave-object-storage',
			project_id: 'proj-abc123',
			workload_kind: 'session',
			workload_id: 's_def456',
			iat,
			nbf: iat - 60,
			exp: iat + 3600,
		});

		// Verify the signature against the public key published in the JWKS.
		const { keys } = await issuer.jwks();
		const pub = await crypto.subtle.importKey('jwk', { ...keys[0] }, RS256_ALG, false, ['verify']);
		const ok = await crypto.subtle.verify(
			RS256_ALG,
			pub,
			fromBase64Url(sigB64) as unknown as ArrayBuffer,
			new TextEncoder().encode(`${headerB64}.${payloadB64}`),
		);
		expect(ok).toBe(true);
	});

	it('honors a custom ttl', async () => {
		const { pem } = await generatePkcs8Pem();
		const fixedNow = 1_700_000_000_000;
		const issuer = new WorkloadIdentityIssuer(pem, 'kid-1', () => fixedNow);
		const jwt = await issuer.mint({ ...claims, ttlSeconds: Seconds.of(900) });
		const payload = decodeSegment(jwt.split('.')[1]);
		expect(payload.exp).toBe(Math.floor(fixedNow / 1000) + 900);
	});

	it('does not let extraClaims override the standard claims', async () => {
		const { pem } = await generatePkcs8Pem();
		const issuer = new WorkloadIdentityIssuer(pem, 'kid-1');
		const jwt = await issuer.mint({
			...claims,
			extraClaims: { iss: 'https://evil.example', sub: 'attacker', custom: 'ok' },
		});
		const payload = decodeSegment(jwt.split('.')[1]);
		expect(payload.iss).toBe(claims.iss);
		expect(payload.sub).toBe(claims.sub);
		expect(payload.custom).toBe('ok');
	});

	it('does not let extraClaims override the computed iat/nbf/exp', async () => {
		const { pem } = await generatePkcs8Pem();
		const fixedNow = 1_700_000_000_000;
		const issuer = new WorkloadIdentityIssuer(pem, 'kid-1', () => fixedNow);
		const iat = Math.floor(fixedNow / 1000);
		const jwt = await issuer.mint({
			...claims,
			// An attacker-supplied far-future exp / zeroed nbf must be ignored.
			extraClaims: { iat: 1, nbf: 0, exp: 9_999_999_999 },
		});
		const payload = decodeSegment(jwt.split('.')[1]);
		expect(payload.iat).toBe(iat);
		expect(payload.nbf).toBe(iat - 60);
		expect(payload.exp).toBe(iat + 3600);
	});

	it('rejects a tampered token: a mutated claim invalidates the RS256 signature', async () => {
		const { pem } = await generatePkcs8Pem();
		const issuer = new WorkloadIdentityIssuer(pem, 'kid-1');
		const jwt = await issuer.mint(claims);
		const [headerB64, payloadB64, sigB64] = jwt.split('.');

		// Escalate the subject, keeping the original signature.
		const payload = decodeSegment(payloadB64);
		payload.sub = 'attacker-controlled';
		const forgedPayloadB64 = utf8ToBase64Url(JSON.stringify(payload));
		const forged = `${headerB64}.${forgedPayloadB64}.${sigB64}`;

		const { keys } = await issuer.jwks();
		const pub = await crypto.subtle.importKey('jwk', { ...keys[0] }, RS256_ALG, false, ['verify']);
		const [h, p, s] = forged.split('.');
		const ok = await crypto.subtle.verify(
			RS256_ALG,
			pub,
			fromBase64Url(s) as unknown as ArrayBuffer,
			new TextEncoder().encode(`${h}.${p}`),
		);
		expect(ok).toBe(false);
	});

	it('publishes a public-only JWKS (no private material)', async () => {
		const { pem } = await generatePkcs8Pem();
		const issuer = new WorkloadIdentityIssuer(pem, 'kid-xyz');
		const { keys } = await issuer.jwks();
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'kid-xyz' });
		expect(keys[0].n).toBeTruthy();
		expect(keys[0].e).toBeTruthy();
		// Must NOT leak the private exponent or primes.
		const serialized = JSON.stringify(keys[0]);
		for (const field of ['"d"', '"p"', '"q"', '"dp"', '"dq"', '"qi"']) {
			expect(serialized).not.toContain(field);
		}
	});
});
