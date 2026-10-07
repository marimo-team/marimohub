import { describe, expect, it, vi } from 'vitest';
import { UnavailableError } from '../../../errors';
import { createRunId, createSessionId } from '../../../ids';
import { ProjectIntegrationsStore } from '../ProjectIntegrationsStore';
import { basicAuthHeader } from '../sdk';
import { codeArtifact } from './codeArtifact';
import { actor, context, fixture, packageIndexStores } from './packageIndexTestkit';

const config = fixture('aws_codeartifact');
const ambientConfig = { ...config, auth: { method: 'ambient' } };
const indexUrl =
	'https://company-123456789012.d.codeartifact.us-east-1.amazonaws.com/pypi/python/simple/';
const draft = (draftConfig: Record<string, unknown> = config) => ({
	source: 'draft' as const,
	kind: 'aws_codeartifact',
	config: draftConfig,
});

describe('CodeArtifact integration', () => {
	it.each([
		{ domain: 'x/../../evil' },
		{ domain_owner: '123' },
		{ region: 'us-east-1.evil.test' },
		{ repository: 'python?token=secret' },
		{ duration_seconds: 3600 },
		{ auth: { method: 'token', token: 'existing-token' } },
		{ auth: { method: 'federation' } },
	])('rejects invalid configuration %j', (invalid) => {
		expect(codeArtifact.configSchema.safeParse({ ...config, ...invalid }).success).toBe(false);
	});

	it('uses the China partition hostname', async () => {
		const s = packageIndexStores();
		await s.project.create(
			s.projectId,
			{ kind: 'aws_codeartifact', name: 'private', config: { ...config, region: 'cn-north-1' } },
			actor,
		);
		expect((await s.project.resolveForSession(s.projectId, context))?.vars.UV_INDEX).toBe(
			'private=https://company-123456789012.d.codeartifact.cn-north-1.amazonaws.com.cn/pypi/python/simple/',
		);
	});

	it('inherits org configuration and keeps credentials out of files and API reads', async () => {
		const s = packageIndexStores();
		const entry = await s.org.create(
			{ kind: 'aws_codeartifact', name: 'private-registry', config },
			actor,
		);
		const render = await s.project.resolveForSession(s.projectId, context);
		expect(render?.vars).toMatchObject({
			UV_INDEX: `private-registry=${indexUrl}`,
			UV_INDEX_PRIVATE_REGISTRY_USERNAME: 'aws',
			UV_INDEX_PRIVATE_REGISTRY_PASSWORD: 'fresh-token',
		});
		expect(render?.attachments[0]).toMatchObject({ id: entry.id, version: 1 });
		expect(JSON.stringify(render?.files)).not.toContain('fresh-token');
		expect(JSON.stringify(await s.org.get(entry.id))).not.toContain('aws-secret');
		const override = await s.project.create(
			s.projectId,
			{ kind: 'aws_codeartifact', name: 'private-registry', config },
			actor,
		);
		await s.project.update(s.projectId, override.id, { enabled: false }, actor);
		expect(
			(await s.project.resolveForSession(s.projectId, context))?.vars.UV_INDEX,
		).toBeUndefined();
	});

	it.each(['session', 'job-run'] as const)(
		'mints fresh credentials for each %s without injecting AWS keys',
		async (kind) => {
			const s = packageIndexStores();
			await s.project.create(
				s.projectId,
				{ kind: 'aws_codeartifact', name: 'private', config },
				actor,
			);
			const workload =
				kind === 'session' ? { kind, id: createSessionId() } : { kind, id: createRunId() };
			const render = await s.project.resolveForSession(s.projectId, { ...context, workload });
			expect(s.resolve).toHaveBeenCalledOnce();
			expect(s.resolve.mock.calls[0][0].auth).toEqual(config.auth);
			expect(render?.vars.UV_INDEX_PRIVATE_PASSWORD).toBe('fresh-token');
			expect(JSON.stringify(render)).not.toContain('AKIDEXAMPLE');
			expect(JSON.stringify(render)).not.toContain('aws-secret');
			expect(JSON.stringify(render?.files)).not.toContain('fresh-token');
			expect(JSON.stringify(render?.files)).toContain('credentials_expire_at');
			s.resolve.mockResolvedValue({ username: 'aws', password: 'next-token' });
			expect(
				(await s.project.resolveForSession(s.projectId, { ...context, workload }))?.vars
					.UV_INDEX_PRIVATE_PASSWORD,
			).toBe('next-token');
		},
	);

	it('never exchanges workload identity for static AWS keys', async () => {
		const s = packageIndexStores();
		await s.project.create(
			s.projectId,
			{ kind: 'aws_codeartifact', name: 'private', config },
			actor,
		);
		const resolveFederatedCredentials = vi.fn(async () => ({
			accessKeyId: 'PROJECT',
			secretAccessKey: 'project-secret',
		}));
		await s.project.resolveForSession(s.projectId, { ...context, resolveFederatedCredentials });
		const federation = { federation: { credentials: await resolveFederatedCredentials() } };
		resolveFederatedCredentials.mockClear();
		await s.project.test(s.projectId, draft(), {
			user_id: actor,
			user_email: 'test@example.com',
			allow_server_ambient: {},
			...(federation as object),
		} as never);
		expect(resolveFederatedCredentials).not.toHaveBeenCalled();
		for (const [, options] of s.resolve.mock.calls) {
			expect(options.federatedCredentials).toBeUndefined();
		}
	});

	it('explains that ambient auth needs project cloud access and passes only project credentials', async () => {
		const s = packageIndexStores();
		await s.org.create({ kind: 'aws_codeartifact', name: 'private', config: ambientConfig }, actor);
		const error = await s.project
			.resolveForSession(s.projectId, context)
			.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(UnavailableError);
		expect((error as Error).message).toBe('CodeArtifact requires project AWS cloud access.');
		expect(s.resolve).not.toHaveBeenCalled();
		const credentials = { accessKeyId: 'PROJECT', secretAccessKey: 'project-secret' };
		await s.project.resolveForSession(s.projectId, {
			...context,
			resolveFederatedCredentials: async () => credentials,
		});
		expect(s.resolve.mock.calls[0][1].federatedCredentials).toEqual(credentials);
	});

	it('merges multiple CodeArtifact indexes', async () => {
		const s = packageIndexStores();
		await s.org.create({ kind: 'aws_codeartifact', name: 'company', config }, actor);
		const team = await s.project.create(
			s.projectId,
			{
				kind: 'aws_codeartifact',
				name: 'team',
				config: { ...config, repository: 'team', default_index: true },
			},
			actor,
		);
		const render = await s.project.resolveForSession(s.projectId, context);
		expect(render?.vars.UV_INDEX).toMatch(/^company=https:/);
		expect(render?.vars.UV_DEFAULT_INDEX).toMatch(/^team=https:.*\/team\/simple\/$/);
		await s.project.update(
			s.projectId,
			team.id,
			{ config: { ...config, repository: 'team', default_index: false } },
			actor,
		);
		expect(
			(await s.project.resolveForSession(s.projectId, context))?.vars.UV_INDEX.split(' '),
		).toHaveLength(2);
	});

	it('tests repository read access with the minted token without echoing failures', async () => {
		const s = packageIndexStores();
		await expect(s.project.test(s.projectId, draft())).resolves.toMatchObject({ ok: true });
		expect(s.fetch).toHaveBeenCalledWith(
			indexUrl,
			expect.objectContaining({
				headers: { Authorization: basicAuthHeader('aws', 'fresh-token') },
			}),
		);
		s.fetch.mockRejectedValue(new Error('fresh-token'));
		const result = await s.project.test(s.projectId, draft());
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain('fresh-token');
	});

	it('fails closed with a 503-class error if token acquisition fails', async () => {
		const s = packageIndexStores();
		await s.org.create({ kind: 'aws_codeartifact', name: 'private', config }, actor);
		s.resolve.mockRejectedValue(new Error('aws-secret'));
		const error = await s.project
			.resolveForSession(s.projectId, context)
			.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(UnavailableError);
		expect((error as Error).message).toBe('Package registry authentication failed.');
		const curated = new UnavailableError(
			'CodeArtifact authentication failed. Check the AWS credentials.',
		);
		s.resolve.mockRejectedValue(curated);
		await expect(s.project.resolveForSession(s.projectId, context)).rejects.toBe(curated);
	});

	it('rejects a minted token containing a control character before injection', async () => {
		const s = packageIndexStores();
		s.resolve.mockResolvedValue({ username: 'aws', password: 'secret\ntoken' });
		await s.project.create(
			s.projectId,
			{ kind: 'aws_codeartifact', name: 'private', config },
			actor,
		);
		await expect(s.project.resolveForSession(s.projectId, context)).rejects.toThrow(
			'Integration "private" could not be rendered.',
		);
	});
});

describe('CodeArtifact failure boundaries', () => {
	it.each(['adapter', 'provisioning probe'] as const)(
		'fails closed without the %s',
		async (missing) => {
			const s = packageIndexStores(
				missing === 'adapter'
					? { packageRegistryCredentials: undefined }
					: { packageRegistryProbe: undefined },
			);
			await s.project.create(
				s.projectId,
				{ kind: 'aws_codeartifact', name: 'private', config },
				actor,
			);
			const error = await s.project
				.resolveForSession(s.projectId, context)
				.catch((err: unknown) => err);
			expect(error).toBeInstanceOf(UnavailableError);
			expect((error as Error).message).toBe(
				'Package registry authentication is unavailable on this deployment.',
			);
			for (const draftConfig of [config, ambientConfig]) {
				await expect(s.project.test(s.projectId, draft(draftConfig))).resolves.toEqual({
					ok: false,
					details: 'Package registry authentication is unavailable on this deployment.',
				});
			}
			expect(s.resolve).not.toHaveBeenCalled();
			expect(s.fetch).not.toHaveBeenCalled();
		},
	);

	it('uses the same authentication probe for connection tests and session rendering', async () => {
		const s = packageIndexStores();
		const registryProbe = { fetch: vi.fn(), connect: vi.fn() };
		const project = new ProjectIntegrationsStore({
			...s.options,
			packageRegistryProbe: registryProbe,
		});
		await project.create(s.projectId, { kind: 'aws_codeartifact', name: 'private', config }, actor);
		await expect(project.test(s.projectId, draft())).resolves.toMatchObject({ ok: true });
		await project.resolveForSession(s.projectId, context);
		expect(s.resolve).toHaveBeenCalledTimes(2);
		for (const [, options] of s.resolve.mock.calls) expect(options.probe).toBe(registryProbe);
		expect(s.fetch).toHaveBeenCalledOnce();
	});

	it('disables connection tests without making an authentication request', async () => {
		const s = packageIndexStores({ probe: undefined });
		expect(
			s.project.listKinds().find((kind) => kind.kind === 'aws_codeartifact')?.supports_test,
		).toBe(false);
		await expect(s.project.test(s.projectId, draft())).rejects.toThrow(
			'Connection testing is not enabled',
		);
		expect(s.resolve).not.toHaveBeenCalled();
		expect(s.fetch).not.toHaveBeenCalled();
	});

	it('does not fall back to another identity after project WIF fails', async () => {
		const s = packageIndexStores();
		await s.org.create({ kind: 'aws_codeartifact', name: 'private', config: ambientConfig }, actor);
		const resolveFederatedCredentials = vi.fn(async () => {
			throw new Error('project-secret');
		});
		const error = await s.project
			.resolveForSession(s.projectId, { ...context, resolveFederatedCredentials })
			.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(UnavailableError);
		expect((error as Error).message).toBe(
			'CodeArtifact could not obtain project AWS cloud access.',
		);
		expect(resolveFederatedCredentials).toHaveBeenCalledOnce();
		expect(s.resolve).not.toHaveBeenCalled();
		expect(s.fetch).not.toHaveBeenCalled();
	});

	it('does not contact AWS when an external secret is unavailable', async () => {
		const s = packageIndexStores({
			resolvers: [
				{
					backend: 'vault',
					title: 'Vault',
					locatorPlaceholder: 'path',
					locatorHelp: 'Secret path',
					resolve: async () => {
						throw new Error('secret-value at private/locator');
					},
				},
			],
		});
		await s.project.create(
			s.projectId,
			{
				kind: 'aws_codeartifact',
				name: 'private',
				config: {
					...config,
					auth: {
						...(config.auth as object),
						secret_access_key: {
							$secret: { kind: 'reference', backend: 'vault', locator: 'private/locator' },
						},
					},
				},
			},
			actor,
		);
		const error = await s.project
			.resolveForSession(s.projectId, context)
			.catch((err: Error) => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toMatch(/secret-value|private\/locator/);
		expect(s.resolve).not.toHaveBeenCalled();
	});

	it.each([401, 403, 404, 429, 503])(
		'reports repository HTTP %s as failure and never reads the response body',
		async (status) => {
			const s = packageIndexStores();
			const json = vi.fn(async () => ({ token: 'fresh-token', error: 'aws-secret' }));
			s.fetch.mockResolvedValue({ ok: false, status, json });
			await expect(s.project.test(s.projectId, draft())).resolves.toEqual({
				ok: false,
				details:
					'Repository access failed. Check the URL, credentials, and package read permissions.',
			});
			expect(s.resolve).toHaveBeenCalledOnce();
			expect(json).not.toHaveBeenCalled();
		},
	);

	it('does not test repository access after token acquisition fails', async () => {
		const s = packageIndexStores();
		s.resolve.mockRejectedValue(new Error('aws-secret'));
		await expect(s.project.test(s.projectId, draft())).resolves.toEqual({
			ok: false,
			details: 'Package registry authentication failed.',
		});
		s.resolve.mockRejectedValue(new DOMException('aws-secret', 'TimeoutError'));
		await expect(s.project.test(s.projectId, draft())).resolves.toEqual({
			ok: false,
			details: 'Package registry authentication timed out.',
		});
		expect(s.fetch).not.toHaveBeenCalled();
	});

	it.each(['before authentication', 'after authentication'] as const)(
		'propagates cancellation of a connection test %s',
		async (timing) => {
			const s = packageIndexStores();
			const controller = new AbortController();
			if (timing === 'before authentication') controller.abort(new Error('aws-secret'));
			else
				s.resolve.mockImplementation(async () => {
					controller.abort(new Error('aws-secret'));
					return { username: 'aws', password: 'fresh-token' };
				});
			const error = await s.project
				.test(s.projectId, draft(), undefined, { signal: controller.signal })
				.catch((err: unknown) => err);
			expect(error).toBeInstanceOf(DOMException);
			expect((error as DOMException).name).toBe('AbortError');
			expect((error as Error).message).not.toMatch(/aws-secret|fresh-token/);
			expect(s.resolve).toHaveBeenCalledTimes(timing === 'before authentication' ? 0 : 1);
			expect(s.fetch).not.toHaveBeenCalled();
		},
	);
});
