import { afterEach, describe, expect, it, vi } from 'vitest';
import { AwsStsWifBroker } from './index';

const ROLE_ARN = 'arn:aws:iam::123456789012:role/marimohub-wif';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Stub global fetch (ofetch uses it under the hood) with a responder. */
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

function stsSuccess(expiration: number | string | undefined = 1768600000) {
	return {
		AssumeRoleWithWebIdentityResponse: {
			AssumeRoleWithWebIdentityResult: {
				Credentials: {
					AccessKeyId: 'ASIATEST',
					SecretAccessKey: 'awssecret',
					SessionToken: 'sess-tok',
					...(expiration === undefined ? {} : { Expiration: expiration }),
				},
			},
			ResponseMetadata: { RequestId: 'req-1' },
		},
	};
}

/** A structurally valid JWT whose payload carries the given claims. */
function fakeJwt(claims: unknown): string {
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
	return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
}

/** Run an exchange expected to fail and return the thrown error message. */
async function exchangeError(broker: AwsStsWifBroker, jwt: string): Promise<string> {
	try {
		await broker.exchange(jwt);
		throw new Error('expected exchange to throw');
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

describe('AwsStsWifBroker', () => {
	it('exchanges a JWT via an unsigned AssumeRoleWithWebIdentity POST', async () => {
		const fetchFn = stubFetch(() => jsonResponse(stsSuccess()));
		const broker = new AwsStsWifBroker({ roleArn: ROLE_ARN });

		const jwt = fakeJwt({ sub: 'proj-7h2k9qm4xz7rp3w8' });
		const creds = await broker.exchange(jwt);

		expect(creds).toEqual({
			accessKeyId: 'ASIATEST',
			secretAccessKey: 'awssecret',
			sessionToken: 'sess-tok',
			// Numeric epoch-seconds Expiration (JSON mode) is normalized to ISO-8601.
			expiration: new Date(1768600000 * 1000).toISOString(),
		});

		const [url, init] = fetchFn.mock.calls[0];
		expect(String(url)).toBe('https://sts.amazonaws.com');
		expect(init?.method).toBe('POST');
		const headers = new Headers(init?.headers);
		expect(headers.get('accept')).toBe('application/json');
		expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
		// No Authorization header — the JWT in the form body is the sole credential.
		expect(headers.get('authorization')).toBeNull();

		const form = new URLSearchParams(String(init?.body));
		expect(form.get('Action')).toBe('AssumeRoleWithWebIdentity');
		expect(form.get('Version')).toBe('2011-06-15');
		expect(form.get('RoleArn')).toBe(ROLE_ARN);
		expect(form.get('WebIdentityToken')).toBe(jwt);
		expect(form.get('RoleSessionName')).toBe('proj-7h2k9qm4xz7rp3w8');
	});

	it('passes through a string Expiration unchanged', async () => {
		stubFetch(() => jsonResponse(stsSuccess('2026-01-23T19:03:47Z')));
		const broker = new AwsStsWifBroker({ roleArn: ROLE_ARN });
		const creds = await broker.exchange(fakeJwt({ sub: 'proj-x1' }));
		expect(creds.expiration).toBe('2026-01-23T19:03:47Z');
	});

	it('sanitizes an out-of-charset sub for the session name', async () => {
		const fetchFn = stubFetch(() => jsonResponse(stsSuccess()));
		const broker = new AwsStsWifBroker({ roleArn: ROLE_ARN });
		await broker.exchange(fakeJwt({ sub: 'proj:with/bad chars' }));
		const form = new URLSearchParams(String(fetchFn.mock.calls[0][1]?.body));
		expect(form.get('RoleSessionName')).toBe('proj-with-bad-chars');
	});

	it('falls back to a static session name when sub is missing or the payload is opaque', async () => {
		const fetchFn = stubFetch(() => jsonResponse(stsSuccess()));
		const broker = new AwsStsWifBroker({ roleArn: ROLE_ARN });

		await broker.exchange(fakeJwt({ aud: 'no-sub' }));
		await broker.exchange('not-even-a-jwt');

		for (const call of fetchFn.mock.calls) {
			const form = new URLSearchParams(String(call[1]?.body));
			expect(form.get('RoleSessionName')).toBe('marimohub-wif');
		}
	});

	it('POSTs to a custom (regional) STS endpoint when configured', async () => {
		const fetchFn = stubFetch(() => jsonResponse(stsSuccess()));
		const broker = new AwsStsWifBroker({
			roleArn: ROLE_ARN,
			stsUrl: 'https://sts.us-east-1.amazonaws.com',
		});
		await broker.exchange(fakeJwt({ sub: 'proj-x1' }));
		expect(String(fetchFn.mock.calls[0][0])).toBe('https://sts.us-east-1.amazonaws.com');
	});

	it("surfaces STS's error code + status (without leaking the JWT)", async () => {
		stubFetch(() =>
			jsonResponse(
				{
					Error: {
						Code: 'InvalidIdentityToken',
						Message: 'No OpenIDConnect provider found in your account',
						Type: 'Sender',
					},
					RequestId: 'req-2',
				},
				400,
			),
		);
		const broker = new AwsStsWifBroker({ roleArn: ROLE_ARN });

		const secretJwt = fakeJwt({ sub: 'proj-secret' });
		const message = await exchangeError(broker, secretJwt);
		expect(message).toContain('STS credential exchange failed');
		expect(message).toContain('HTTP 400');
		expect(message).toContain('InvalidIdentityToken');
		expect(message).toContain('No OpenIDConnect provider');
		expect(message).not.toContain(secretJwt); // never the JWT
	});

	it('extracts the code/message from an XML error body (fallback path)', async () => {
		stubFetch(
			() =>
				new Response(
					'<ErrorResponse><Error><Code>ExpiredTokenException</Code>' +
						'<Message>Token expired</Message></Error></ErrorResponse>',
					{ status: 403, headers: { 'content-type': 'text/xml' } },
				),
		);
		const broker = new AwsStsWifBroker({ roleArn: ROLE_ARN });
		const message = await exchangeError(broker, fakeJwt({ sub: 'proj-x1' }));
		expect(message).toContain('HTTP 403');
		expect(message).toContain('ExpiredTokenException');
		expect(message).toContain('Token expired');
	});

	it('rejects a malformed success body, naming the bad field', async () => {
		stubFetch(() =>
			jsonResponse({
				AssumeRoleWithWebIdentityResponse: {
					AssumeRoleWithWebIdentityResult: {
						Credentials: { AccessKeyId: 'ASIATEST', SessionToken: 'tok' },
					},
				},
			}),
		);
		const broker = new AwsStsWifBroker({ roleArn: ROLE_ARN });
		const message = await exchangeError(broker, fakeJwt({ sub: 'proj-x1' }));
		expect(message).toContain('unexpected response shape');
		expect(message).toContain('SecretAccessKey');
	});

	it('fails fast (construction) on a malformed role ARN', () => {
		expect(() => new AwsStsWifBroker({ roleArn: 'not-an-arn' })).toThrow(
			/MARIMOHUB_WIF_AWS_ROLE_ARN/,
		);
	});

	it('fails fast when given a non-URL STS endpoint', () => {
		expect(() => new AwsStsWifBroker({ roleArn: ROLE_ARN, stsUrl: 'not-a-url' })).toThrow(
			/not a URL/,
		);
	});

	// Retry invariant (avoid double-minting): only 429/503/504 are retried; a 500/502
	// may mean the mint partially succeeded, so it must NOT be replayed.
	it.each([500, 502])('does not retry a %d (mint may have partially succeeded)', async (status) => {
		const fetchFn = stubFetch(() => jsonResponse({ Error: { Code: 'InternalError' } }, status));
		const broker = new AwsStsWifBroker({ roleArn: ROLE_ARN });
		await exchangeError(broker, fakeJwt({ sub: 'proj-x1' }));
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it.each([429, 503])('retries a %d then exhausts to an error', async (status) => {
		const fetchFn = stubFetch(() => jsonResponse({ Error: { Code: 'Throttling' } }, status));
		const broker = new AwsStsWifBroker({ roleArn: ROLE_ARN });
		const message = await exchangeError(broker, fakeJwt({ sub: 'proj-x1' }));
		// retry: 2 → the original call plus two retries.
		expect(fetchFn).toHaveBeenCalledTimes(3);
		expect(message).toContain(`HTTP ${status}`);
	});

	it('surfaces a bare failure on a network error without leaking the JWT', async () => {
		stubFetch(() => {
			throw new Error('ECONNRESET tunnel closed');
		});
		const broker = new AwsStsWifBroker({ roleArn: ROLE_ARN });
		const secretJwt = fakeJwt({ sub: 'proj-super-secret' });
		const message = await exchangeError(broker, secretJwt);
		expect(message).toContain('STS credential exchange failed');
		expect(message).not.toContain(secretJwt);
	});

	it.each(['12345678901', '1234567890123'])('rejects a non-12-digit account id (%s)', (account) => {
		expect(
			() => new AwsStsWifBroker({ roleArn: `arn:aws:iam::${account}:role/marimohub-wif` }),
		).toThrow(/MARIMOHUB_WIF_AWS_ROLE_ARN/);
	});

	it.each(['aws-cn', 'aws-us-gov'])('accepts the %s partition', (partition) => {
		expect(
			() =>
				new AwsStsWifBroker({ roleArn: `arn:${partition}:iam::123456789012:role/marimohub-wif` }),
		).not.toThrow();
	});

	it('rejects a success body whose Expiration is neither number nor string', async () => {
		stubFetch(() => jsonResponse(stsSuccess(true as unknown as number)));
		const broker = new AwsStsWifBroker({ roleArn: ROLE_ARN });
		const message = await exchangeError(broker, fakeJwt({ sub: 'proj-x1' }));
		expect(message).toContain('unexpected response shape');
		expect(message).toContain('Expiration');
	});
});
