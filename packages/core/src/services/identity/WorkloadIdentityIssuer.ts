/**
 * The hub as an OIDC issuer for Workload Identity Federation: mints short-lived
 * RS256 JWTs and publishes the matching public JWKS, so an external service (e.g.
 * CoreWeave AI Object Storage) can validate a token and exchange it for temporary
 * credentials — no long-lived key leaves the hub.
 *
 * Signs with Web Crypto (`crypto.subtle`), like `proxyToken.ts`, so `core` stays
 * vendor- and runtime-agnostic (no `jose`, no `node:crypto`). The keypair is
 * operator-supplied, not generated, so it is stable across pod restarts.
 */
import { Millis, Seconds } from '../../duration';
import { utf8ToBase64Url, toBase64Url } from '../../internal/base64url';

const RS256_ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const DEFAULT_TTL_SECONDS = Seconds.hours(1);
/** Backdate `nbf` so a validator with a slightly fast clock doesn't reject a
 *  freshly-minted token as not-yet-valid. */
const CLOCK_SKEW_SECONDS = Seconds.of(60);

export interface WifClaims {
	/** Stable issuer URL — the hub's public origin, e.g. `https://hub.example.com`. */
	iss: string;
	/** Federated subject; this effort passes the project id (see `projectSubject`). */
	sub: string;
	/** Expected audience of the consuming cloud (its WIF config's client id). */
	aud: string | string[];
	/** Token lifetime in seconds (default 3600). */
	ttlSeconds?: Seconds;
	/**
	 * Extra non-standard claims to embed (e.g. `project_id`, `session_id`). They
	 * cannot override the standard `iss`/`sub`/`aud`/`iat`/`nbf`/`exp` claims.
	 */
	extraClaims?: Record<string, unknown>;
}

/** A single RSA public key in JWK form, as published in the JWKS `keys` array. */
export interface JwksKey {
	kty: 'RSA';
	use: 'sig';
	alg: 'RS256';
	kid: string;
	n: string;
	e: string;
}

/** Strip PEM armor + whitespace and base64-decode to DER bytes. */
function pemToDer(pem: string): ArrayBuffer {
	const body = pem
		.replace(/-----BEGIN [^-]+-----/, '')
		.replace(/-----END [^-]+-----/, '')
		.replaceAll(/\s+/g, '');
	const bin = atob(body);
	const der = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
	return der.buffer;
}

export class WorkloadIdentityIssuer {
	private privateKeyPromise?: Promise<CryptoKey>;
	private jwksPromise?: Promise<{ keys: JwksKey[] }>;

	/**
	 * @param privateKeyPkcs8Pem operator-supplied RSA private key (PKCS8 PEM).
	 * @param kid                key id surfaced in the JWT header and the JWKS.
	 * @param now                injectable clock (ms); defaults to `Date.now`.
	 */
	constructor(
		private readonly privateKeyPkcs8Pem: string,
		private readonly kid: string,
		private readonly now: () => number = () => Date.now(),
	) {}

	private importPrivateKey(): Promise<CryptoKey> {
		// `extractable: true` so `jwks()` can export the public params from it.
		this.privateKeyPromise ??= crypto.subtle.importKey(
			'pkcs8',
			pemToDer(this.privateKeyPkcs8Pem),
			RS256_ALG,
			true,
			['sign'],
		);
		return this.privateKeyPromise;
	}

	/** Mint a signed compact JWS (RS256). The token is never logged. */
	async mint(claims: WifClaims): Promise<string> {
		const key = await this.importPrivateKey();
		const iat = Millis.toSeconds(Millis.of(this.now()));
		const exp = iat + (claims.ttlSeconds ?? DEFAULT_TTL_SECONDS);
		const header = { alg: 'RS256', typ: 'JWT', kid: this.kid };
		// extraClaims first so the standard claims below always win a name collision.
		const payload = {
			...claims.extraClaims,
			iss: claims.iss,
			sub: claims.sub,
			aud: claims.aud,
			iat,
			nbf: iat - CLOCK_SKEW_SECONDS,
			exp,
		};
		const signingInput = `${utf8ToBase64Url(JSON.stringify(header))}.${utf8ToBase64Url(
			JSON.stringify(payload),
		)}`;
		const sig = await crypto.subtle.sign(RS256_ALG, key, new TextEncoder().encode(signingInput));
		return `${signingInput}.${toBase64Url(new Uint8Array(sig))}`;
	}

	/** The public JWKS (`{ keys: [...] }`) — never includes private material. */
	async jwks(): Promise<{ keys: JwksKey[] }> {
		this.jwksPromise ??= (async () => {
			const key = await this.importPrivateKey();
			// exportKey('jwk') is typed ArrayBuffer | JsonWebKey; narrow without a cast.
			const jwk = await crypto.subtle.exportKey('jwk', key);
			if (jwk instanceof ArrayBuffer) throw new Error('expected a JWK key export');
			// Keep only the public RSA params (n, e); drop d/p/q/dp/dq/qi.
			return {
				keys: [
					{
						kty: 'RSA',
						use: 'sig',
						alg: 'RS256',
						kid: this.kid,
						n: jwk.n!,
						e: jwk.e!,
					},
				],
			};
		})();
		return this.jwksPromise;
	}
}
