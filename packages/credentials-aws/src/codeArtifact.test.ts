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

function makeProbe() {
	const fetch = vi.fn<IntegrationProbe['fetch']>(async () => ({
		ok: true,
		status: 200,
		json: async () => ({
			authorizationToken: 'registry-token',
			expiration: Date.now() / 1000 + 3600,
		}),
	}));
	return { fetch, connect: vi.fn() } satisfies IntegrationProbe;
}

describe('AWS CodeArtifact credentials', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
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
		const federated = { ...source, auth: { method: 'ambient' as const } };
		await expect(adapter.resolve(federated, { probe })).rejects.toThrow(
			'CodeArtifact authentication failed',
		);
		expect(probe.fetch).not.toHaveBeenCalled();
		await adapter.resolve(federated, {
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
				new AwsCodeArtifactCredentials().resolve(
					{ ...source, auth: { method: 'ambient' } },
					{ probe, federatedCredentials },
				),
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
