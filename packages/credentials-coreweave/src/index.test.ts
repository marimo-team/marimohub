import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreWeaveWifBroker } from './index';

const EXCHANGE_URL = 'https://api.coreweave.test/v1/cwobject/temporary-credentials/oidc/test-id';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Stub global fetch (ofetch uses it under the hood) with a JSON responder. */
function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
		impl(String(input), init),
	);
	vi.stubGlobal('fetch', fn);
	return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** Run an exchange expected to fail and return the thrown error message. */
async function exchangeError(broker: CoreWeaveWifBroker, jwt: string): Promise<string> {
	try {
		await broker.exchange(jwt);
		throw new Error('expected exchange to throw');
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

describe('CoreWeaveWifBroker', () => {
	it('exchanges a JWT for temp creds, sending the raw JWT as Authorization', async () => {
		const fetchFn = stubFetch(() =>
			jsonResponse({
				AccessKeyId: 'CWAK',
				SecretAccessKey: 'cwsecret',
				Token: 'sess-tok',
				Expiration: '2026-01-23T19:03:47Z',
			}),
		);
		const broker = new CoreWeaveWifBroker({ exchangeUrl: EXCHANGE_URL });

		const creds = await broker.exchange('eyJ.jwt.sig');

		expect(creds).toEqual({
			accessKeyId: 'CWAK',
			secretAccessKey: 'cwsecret',
			sessionToken: 'sess-tok',
			expiration: '2026-01-23T19:03:47Z',
		});
		const [url, init] = fetchFn.mock.calls[0];
		expect(String(url)).toBe(EXCHANGE_URL);
		expect(init?.method).toBe('GET');
		// Raw JWT, not `Bearer <jwt>`.
		expect(new Headers(init?.headers).get('authorization')).toBe('eyJ.jwt.sig');
	});

	it('maps an empty Token to undefined sessionToken', async () => {
		stubFetch(() => jsonResponse({ AccessKeyId: 'AK', SecretAccessKey: 'sk', Token: '' }));
		const broker = new CoreWeaveWifBroker({ exchangeUrl: EXCHANGE_URL });
		const creds = await broker.exchange('jwt');
		expect(creds.sessionToken).toBeUndefined();
	});

	it("surfaces CoreWeave's error message + status (without leaking the JWT)", async () => {
		// The real CAIOS error envelope: { code, message, details }.
		stubFetch(() =>
			jsonResponse(
				{ code: 3, message: 'invalid request sent to auth endpoint, Invalid token', details: [] },
				400,
			),
		);
		const broker = new CoreWeaveWifBroker({ exchangeUrl: EXCHANGE_URL });

		const secretJwt = 'eyJ.super-secret-jwt.sig';
		const message = await exchangeError(broker, secretJwt);
		expect(message).toContain('CAIOS credential exchange failed');
		expect(message).toContain('HTTP 400');
		expect(message).toContain('Invalid token'); // CoreWeave's own message, for debugging
		expect(message).not.toContain(secretJwt); // never the JWT
	});

	it('rejects a malformed success body, naming the bad field', async () => {
		// Missing SecretAccessKey, AccessKeyId is empty.
		stubFetch(() => jsonResponse({ AccessKeyId: '' }));
		const broker = new CoreWeaveWifBroker({ exchangeUrl: EXCHANGE_URL });
		const message = await exchangeError(broker, 'jwt');
		expect(message).toContain('unexpected response shape');
		expect(message).toContain('SecretAccessKey');
	});

	it('fails fast (construction) when given the OIDC issuer URL by mistake', () => {
		expect(
			() =>
				new CoreWeaveWifBroker({
					exchangeUrl: 'https://oidc.cks.coreweave.com/id/115d010f-7921-456a-9235-2a45b07db1a9',
				}),
		).toThrow(/issuer URL, not the credential endpoint/);
	});

	it('fails fast when given a non-URL', () => {
		expect(() => new CoreWeaveWifBroker({ exchangeUrl: 'not-a-url' })).toThrow(/not a URL/);
	});
});
