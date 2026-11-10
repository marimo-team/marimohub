import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationProbe } from '@marimo-hub/core/ports/integrations';
import type { CodeArtifactSource } from '@marimo-hub/core/ports/package-registry';
import { AwsCodeArtifactCredentials } from './codeArtifact';

const authenticationError =
	'CodeArtifact authentication failed. Check the AWS credentials, region, domain, and IAM permissions.';

const source: CodeArtifactSource = {
	provider: 'aws_codeartifact',
	domain: 'company',
	domain_owner: '123456789012',
	repository: 'python',
	region: 'eu-west-1',
	auth: {
		method: 'static',
		access_key_id: 'AKIDEXAMPLE',
		secret_access_key: 'aws-secret',
		session_token: 'aws-session',
	},
};

const federatedSource: CodeArtifactSource = { ...source, auth: { method: 'ambient' } };

type ProbeResponse = Awaited<ReturnType<IntegrationProbe['fetch']>>;

function federatedOptions(probe: IntegrationProbe, accessKeyId = 'AK') {
	return {
		probe,
		federatedSourceIdentity: 'config/project/session',
		federatedCredentials: {
			accessKeyId,
			secretAccessKey: `secret-${accessKeyId}`,
			sessionToken: `session-${accessKeyId}`,
			expiration: new Date(Date.now() + 60 * 60_000).toISOString(),
		},
	};
}

function tokenResponse(authorizationToken = 'registry-token', lifetimeSeconds = 43_200) {
	return {
		ok: true,
		status: 200,
		json: async () => ({ authorizationToken, expiration: Date.now() / 1000 + lifetimeSeconds }),
	};
}

function makeProbe() {
	return {
		fetch: vi.fn<IntegrationProbe['fetch']>(async () => tokenResponse()),
		connect: vi.fn(),
	} satisfies IntegrationProbe;
}

describe('AWS CodeArtifact credentials', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	it('coalesces mints, returns independent values, and refreshes below ten hours remaining', async () => {
		vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), toFake: ['Date'] });
		const probe = makeProbe();
		const adapter = new AwsCodeArtifactCredentials();
		const [first, second] = await Promise.all([
			adapter.resolve(source, { probe }),
			adapter.resolve(source, { probe }),
		]);
		expect(first).toEqual(second);
		first.password = 'mutated';
		vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
		expect((await adapter.resolve(source, { probe })).password).toBe('registry-token');
		expect(probe.fetch).toHaveBeenCalledOnce();
		vi.setSystemTime(new Date('2026-01-01T02:00:00.001Z'));
		await adapter.resolve(source, { probe });
		expect(probe.fetch).toHaveBeenCalledTimes(2);
	});

	it('reuses a federated token across STS rotations until its refresh boundary', async () => {
		const start = new Date('2026-01-01T00:00:00Z').getTime();
		vi.useFakeTimers({ now: start, toFake: ['Date'] });
		const probe = makeProbe();
		const adapter = new AwsCodeArtifactCredentials();
		const resolve = (rotation: number) =>
			adapter.resolve(federatedSource, federatedOptions(probe, `AK${rotation}`));
		const first = await resolve(0);
		for (let rotation = 1; rotation <= 3; rotation++) {
			vi.setSystemTime(start + rotation * 40 * 60_000);
			expect(await resolve(rotation)).toEqual(first);
			expect(probe.fetch).toHaveBeenCalledOnce();
		}
		vi.setSystemTime(start + 120 * 60_000 + 1);
		await Promise.all([resolve(3), resolve(3)]);
		expect(probe.fetch).toHaveBeenCalledTimes(2);
		expect(probe.fetch.mock.calls[1][1]?.headers?.authorization).toContain('Credential=AK3/');
	});

	it('isolates federated sources and requires credentials even with a cached source identity', async () => {
		const probe = makeProbe();
		const adapter = new AwsCodeArtifactCredentials();
		const federatedCredentials = { accessKeyId: 'AK', secretAccessKey: 'secret' };
		for (const federatedSourceIdentity of [
			'config/project/session',
			'config/other/session',
			'other/project/session',
			'config/project/job',
		]) {
			await adapter.resolve(federatedSource, {
				probe,
				federatedCredentials,
				federatedSourceIdentity,
			});
		}
		expect(probe.fetch).toHaveBeenCalledTimes(4);
		await expect(
			adapter.resolve(federatedSource, {
				probe,
				federatedSourceIdentity: 'config/project/session',
			}),
		).rejects.toThrow(authenticationError);
		expect(probe.fetch).toHaveBeenCalledTimes(4);
	});

	it.each([
		{ accessKeyId: '', secretAccessKey: 'secret' },
		{ accessKeyId: 'AK', secretAccessKey: '' },
	])('rejects incomplete credentials with a warm federated token: %j', async (incomplete) => {
		const probe = makeProbe();
		const adapter = new AwsCodeArtifactCredentials();
		const options = federatedOptions(probe);
		const first = await adapter.resolve(federatedSource, options);
		await expect(
			adapter.resolve(federatedSource, { ...options, federatedCredentials: incomplete }),
		).rejects.toThrow(authenticationError);
		expect(await adapter.resolve(federatedSource, options)).toEqual(first);
		expect(probe.fetch).toHaveBeenCalledOnce();
	});

	it.each(['transport', 'http', 'malformed', 'expired'] as const)(
		'shares a federated refresh %s failure across rotating credentials and retries without stale tokens',
		async (failure) => {
			vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), toFake: ['Date'] });
			const probe = makeProbe();
			const adapter = new AwsCodeArtifactCredentials();
			const resolve = (accessKeyId: string) =>
				adapter.resolve(federatedSource, federatedOptions(probe, accessKeyId));
			await resolve('initial');
			vi.setSystemTime(new Date('2026-01-01T02:00:00.001Z'));
			const response = Promise.withResolvers<ProbeResponse>();
			probe.fetch.mockReturnValueOnce(response.promise);
			const results = Promise.allSettled([resolve('rotation1'), resolve('rotation2')]);
			await vi.waitFor(() => expect(probe.fetch).toHaveBeenCalledTimes(2));
			if (failure === 'transport') response.reject(new Error('secret registry-token'));
			else if (failure === 'http') response.resolve({ ...tokenResponse(), ok: false, status: 403 });
			else
				response.resolve(
					tokenResponse(
						failure === 'malformed' ? '' : 'expired',
						failure === 'expired' ? 0 : 43_200,
					),
				);
			expect(await results).toEqual([
				{ status: 'rejected', reason: expect.objectContaining({ message: authenticationError }) },
				{ status: 'rejected', reason: expect.objectContaining({ message: authenticationError }) },
			]);
			probe.fetch.mockResolvedValueOnce(tokenResponse('recovered'));
			expect((await resolve('rotation3')).password).toBe('recovered');
			expect(probe.fetch).toHaveBeenCalledTimes(3);
			expect(probe.fetch.mock.calls[2][1]?.headers?.authorization).toContain(
				'Credential=rotation3/',
			);
			expect((await resolve('rotation4')).password).toBe('recovered');
			expect(probe.fetch).toHaveBeenCalledTimes(3);
		},
	);

	it('keys unlabelled federated credentials and static credentials by their secret values', async () => {
		const probe = makeProbe();
		const adapter = new AwsCodeArtifactCredentials();
		for (const secret of ['first', 'second', 'second']) {
			await adapter.resolve(federatedSource, {
				probe,
				federatedCredentials: { accessKeyId: 'AK', secretAccessKey: secret },
			});
			await adapter.resolve(
				{ ...source, auth: { method: 'static', access_key_id: 'AK', secret_access_key: secret } },
				{
					probe,
					federatedSourceIdentity: 'ignored-for-static',
				},
			);
		}
		expect(probe.fetch).toHaveBeenCalledTimes(4);
	});

	it('retries rejected mints without caching the failure', async () => {
		const probe = makeProbe();
		probe.fetch.mockRejectedValueOnce(new Error('unavailable'));
		const adapter = new AwsCodeArtifactCredentials();
		await expect(adapter.resolve(source, { probe })).rejects.toThrow(authenticationError);
		await adapter.resolve(source, { probe });
		expect(probe.fetch).toHaveBeenCalledTimes(2);
	});

	it('separates domains, owners, regions, auth methods, and rotated credentials', async () => {
		const probe = makeProbe();
		const adapter = new AwsCodeArtifactCredentials();
		const auth = {
			method: 'static' as const,
			access_key_id: 'AKIDEXAMPLE',
			secret_access_key: 'aws-secret',
			session_token: 'aws-session',
		};
		for (const variant of [
			source,
			{ ...source, domain: 'another' },
			{ ...source, domain_owner: '999999999999' },
			{ ...source, region: 'us-east-1' },
			{ ...source, auth: { ...auth, access_key_id: 'rotated' } },
			{ ...source, auth: { ...auth, secret_access_key: 'rotated' } },
			{ ...source, auth: { method: 'ambient' as const } },
		]) {
			await adapter.resolve(variant, {
				probe,
				federatedCredentials: {
					accessKeyId: auth.access_key_id,
					secretAccessKey: auth.secret_access_key,
					sessionToken: auth.session_token,
				},
			});
		}
		expect(probe.fetch).toHaveBeenCalledTimes(7);
	});

	it('evicts tokens at the configured bound', async () => {
		const probe = makeProbe();
		const adapter = new AwsCodeArtifactCredentials(2);
		for (const domain of ['one', 'two', 'one', 'three', 'one', 'two']) {
			await adapter.resolve({ ...source, domain }, { probe });
		}
		expect(probe.fetch).toHaveBeenCalledTimes(4);
	});

	it('shares a failed mint across concurrent starts and retries afterward', async () => {
		const probe = makeProbe();
		const response = Promise.withResolvers<ProbeResponse>();
		probe.fetch.mockReturnValueOnce(response.promise);
		const adapter = new AwsCodeArtifactCredentials();
		const first = adapter.resolve(source, { probe });
		const second = adapter.resolve(source, { probe });
		const results = Promise.allSettled([first, second]);
		await vi.waitFor(() => expect(probe.fetch).toHaveBeenCalledOnce());
		response.reject(new Error('aws-secret registry-token'));
		expect(await results).toEqual([
			{ status: 'rejected', reason: expect.objectContaining({ message: authenticationError }) },
			{ status: 'rejected', reason: expect.objectContaining({ message: authenticationError }) },
		]);
		await adapter.resolve(source, { probe });
		expect(probe.fetch).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ outcome: 'failure', method: 'static' },
		{ outcome: 'success', method: 'static' },
		{ outcome: 'failure', method: 'ambient' },
		{ outcome: 'success', method: 'ambient' },
	] as const)(
		'an evicted $method mint settling with $outcome cannot remove or replace its successor',
		async ({ outcome, method }) => {
			const probe = makeProbe();
			const mintSource = method === 'static' ? source : federatedSource;
			const options = federatedOptions(probe);
			const response = Promise.withResolvers<ProbeResponse>();
			probe.fetch.mockReturnValueOnce(response.promise);
			const adapter = new AwsCodeArtifactCredentials(1);
			const pending = adapter.resolve(mintSource, options);
			const settled = Promise.allSettled([pending]);
			await vi.waitFor(() => expect(probe.fetch).toHaveBeenCalledOnce());
			await adapter.resolve({ ...mintSource, domain: 'other' }, options);
			const replacement = await adapter.resolve(mintSource, options);
			if (outcome === 'failure') response.reject(new Error('failed'));
			else response.resolve(tokenResponse('old-token'));
			expect((await settled)[0].status).toBe(outcome === 'failure' ? 'rejected' : 'fulfilled');
			expect(await adapter.resolve(mintSource, options)).toEqual(replacement);
			expect(probe.fetch).toHaveBeenCalledTimes(3);
		},
	);

	it('does not return the old token when refresh fails', async () => {
		vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), toFake: ['Date'] });
		const probe = makeProbe();
		const adapter = new AwsCodeArtifactCredentials();
		await adapter.resolve(source, { probe });
		vi.setSystemTime(new Date('2026-01-01T02:00:00.001Z'));
		probe.fetch.mockRejectedValueOnce(new Error('failed refresh'));
		await expect(adapter.resolve(source, { probe })).rejects.toThrow(authenticationError);
		await adapter.resolve(source, { probe });
		expect(probe.fetch).toHaveBeenCalledTimes(3);
	});

	it.each(['short-lived', 'malformed'] as const)(
		'does not reuse a %s mint result',
		async (kind) => {
			const probe = makeProbe();
			probe.fetch.mockResolvedValueOnce(
				tokenResponse(kind === 'malformed' ? '' : 'short-token', 3600),
			);
			const adapter = new AwsCodeArtifactCredentials();
			const first = adapter.resolve(source, { probe });
			if (kind === 'malformed') await expect(first).rejects.toThrow(authenticationError);
			else expect((await first).password).toBe('short-token');
			expect((await adapter.resolve(source, { probe })).password).toBe('registry-token');
			expect(probe.fetch).toHaveBeenCalledTimes(2);
		},
	);

	it.each(['static', 'ambient'] as const)(
		'keeps %s caller cancellation separate from a concurrent shared mint',
		async (method) => {
			const probe = makeProbe();
			const mintSource = method === 'static' ? source : federatedSource;
			const options = federatedOptions(probe);
			const sharedResponse = Promise.withResolvers<ProbeResponse>();
			probe.fetch.mockReturnValueOnce(sharedResponse.promise);
			const adapter = new AwsCodeArtifactCredentials();
			const shared = adapter.resolve(mintSource, options);
			await vi.waitFor(() => expect(probe.fetch).toHaveBeenCalledOnce());
			const cancelledStarted = Promise.withResolvers<void>();
			probe.fetch.mockImplementationOnce(
				async (_url, init) =>
					new Promise((_resolve, reject) => {
						init!.signal!.addEventListener('abort', () => reject(new Error('sensitive')), {
							once: true,
						});
						cancelledStarted.resolve();
					}),
			);
			const caller = new AbortController();
			const cancelled = adapter.resolve(mintSource, { ...options, signal: caller.signal });
			const failure = expect(cancelled).rejects.toMatchObject({
				name: 'AbortError',
				message: 'CodeArtifact authentication cancelled.',
			});
			await cancelledStarted.promise;
			caller.abort();
			await failure;
			expect(probe.fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
			sharedResponse.resolve(tokenResponse('shared-token'));
			expect((await shared).password).toBe('shared-token');
			expect((await adapter.resolve(mintSource, options)).password).toBe('shared-token');
			await expect(
				adapter.resolve(mintSource, { ...options, signal: AbortSignal.abort() }),
			).rejects.toMatchObject({ name: 'AbortError' });
			expect(probe.fetch).toHaveBeenCalledTimes(2);
		},
	);

	it('signs the token request with explicit credentials through the guarded probe', async () => {
		const probe = makeProbe();
		const token = await new AwsCodeArtifactCredentials().resolve(source, { probe });
		expect(token).toMatchObject({ username: 'aws', password: 'registry-token' });
		expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now());
		const [url, init] = probe.fetch.mock.calls[0];
		expect(url).toBe(
			'https://codeartifact.eu-west-1.amazonaws.com/v1/authorization-token?domain=company&domain-owner=123456789012&duration=43200',
		);
		expect(init?.method).toBe('POST');
		expect(init?.headers?.authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/codeartifact\/aws4_request,/,
		);
		expect(init?.headers?.['x-amz-security-token']).toBe('aws-session');
		expect(init?.body).toBeUndefined();
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it('uses supplied project credentials for ambient auth and never the hub identity', async () => {
		const probe = makeProbe();
		const adapter = new AwsCodeArtifactCredentials();
		await expect(adapter.resolve(federatedSource, { probe })).rejects.toThrow(
			'CodeArtifact authentication failed',
		);
		expect(probe.fetch).not.toHaveBeenCalled();
		await adapter.resolve(federatedSource, {
			probe,
			federatedCredentials: {
				accessKeyId: 'PROJECT',
				secretAccessKey: 'project-secret',
				sessionToken: 'project-session',
			},
		});
		expect(probe.fetch.mock.calls[0][1]?.headers?.authorization).toContain('Credential=PROJECT/');
	});

	it('uses the China partition endpoint', async () => {
		const probe = makeProbe();
		await new AwsCodeArtifactCredentials().resolve({ ...source, region: 'cn-north-1' }, { probe });
		expect(probe.fetch.mock.calls[0][0]).toMatch(
			/^https:\/\/codeartifact.cn-north-1.amazonaws.com.cn\//,
		);
	});

	it.each([401, 403, 404, 429, 500, 503])(
		'rejects HTTP %s without reading or exposing the error body',
		async (status) => {
			const probe = makeProbe();
			const json = vi.fn(async () => ({ message: 'aws-secret registry-token' }));
			probe.fetch.mockResolvedValue({ ok: false, status, json });
			await expect(
				new AwsCodeArtifactCredentials().resolve(source, { probe }),
			).rejects.toMatchObject({
				message: authenticationError,
			});
			expect(json).not.toHaveBeenCalled();
			expect(probe.fetch).toHaveBeenCalledOnce();
		},
	);

	it.each([
		['missing token', undefined, 3600],
		['empty token', '', 3600],
		['oversized token', 't'.repeat(16385), 3600],
		['newline', 'registry-token\n', 3600],
		['non-ASCII token', 'registry-tokené', 3600],
		['expired token', 'registry-token', -1],
		['expires now', 'registry-token', 0],
		['missing expiry', 'registry-token', undefined],
		['non-finite expiry', 'registry-token', Infinity],
		['unrepresentable date', 'registry-token', 1e15],
	] as const)(
		'rejects %s without exposing response values',
		async (_label, authorizationToken, seconds) => {
			vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), toFake: ['Date'] });
			const probe = makeProbe();
			probe.fetch.mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					authorizationToken,
					expiration: seconds === undefined ? undefined : Date.now() / 1000 + seconds,
				}),
			});
			await expect(
				new AwsCodeArtifactCredentials().resolve(source, { probe }),
			).rejects.toMatchObject({
				message: authenticationError,
			});
		},
	);

	it.each(['transport', 'JSON decoding'] as const)('sanitizes %s exceptions', async (stage) => {
		const probe = makeProbe();
		const fail = async () => {
			throw new Error('aws-secret registry-token');
		};
		if (stage === 'transport') probe.fetch.mockImplementation(fail);
		else probe.fetch.mockResolvedValue({ ok: true, status: 200, json: fail });
		await expect(new AwsCodeArtifactCredentials().resolve(source, { probe })).rejects.toMatchObject(
			{
				message: authenticationError,
			},
		);
	});

	it.each([
		{ accessKeyId: '', secretAccessKey: 'secret' },
		{ accessKeyId: 'KEY', secretAccessKey: '' },
	])(
		'does not send requests with incomplete federated credentials',
		async (federatedCredentials) => {
			const probe = makeProbe();
			await expect(
				new AwsCodeArtifactCredentials().resolve(federatedSource, { probe, federatedCredentials }),
			).rejects.toThrow('CodeArtifact authentication failed');
			expect(probe.fetch).not.toHaveBeenCalled();
		},
	);

	it('rejects an invalid region before sending credentials', async () => {
		const probe = makeProbe();
		await expect(
			new AwsCodeArtifactCredentials().resolve(
				{ ...source, region: 'us-east-1.evil.example' },
				{ probe },
			),
		).rejects.toThrow('CodeArtifact authentication failed');
		expect(probe.fetch).not.toHaveBeenCalled();
	});

	it.each([new Error('registry-token'), new DOMException('registry-token', 'AbortError')])(
		'does not request a token for an already-cancelled operation',
		async (reason) => {
			const probe = makeProbe();
			await expect(
				new AwsCodeArtifactCredentials().resolve(source, {
					probe,
					signal: AbortSignal.abort(reason),
				}),
			).rejects.toMatchObject({
				name: 'AbortError',
				message: 'CodeArtifact authentication cancelled.',
			});
			expect(probe.fetch).not.toHaveBeenCalled();
		},
	);

	it.each([
		['AbortError', 'CodeArtifact authentication cancelled.'],
		['TimeoutError', 'CodeArtifact authentication timed out.'],
	])('preserves %s from the transport without exposing its message', async (name, message) => {
		const probe = makeProbe();
		probe.fetch.mockRejectedValue(new DOMException('registry-token', name));
		await expect(new AwsCodeArtifactCredentials().resolve(source, { probe })).rejects.toMatchObject(
			{ name, message },
		);
	});

	it.each(['caller', 'deadline'] as const)(
		'aborts an in-flight request when the %s cancels it',
		async (cancel) => {
			const caller = new AbortController();
			const deadline = new AbortController();
			const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
			const probe = makeProbe();
			const started = Promise.withResolvers<void>();
			probe.fetch.mockImplementation(async (_url, init) => {
				const signal = init!.signal!;
				return new Promise((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('aws-secret')), { once: true });
					started.resolve();
				});
			});
			const result = new AwsCodeArtifactCredentials().resolve(source, {
				probe,
				signal: caller.signal,
			});
			const failure = expect(result).rejects.toMatchObject({
				name: cancel === 'caller' ? 'AbortError' : 'TimeoutError',
				message:
					cancel === 'caller'
						? 'CodeArtifact authentication cancelled.'
						: 'CodeArtifact authentication timed out.',
			});
			await started.promise;
			expect(timeout).toHaveBeenCalledWith(10_000);
			if (cancel === 'caller') caller.abort(new Error('aws-secret'));
			else deadline.abort(new DOMException('aws-secret', 'TimeoutError'));
			await failure;
			expect(probe.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
		},
	);
});
