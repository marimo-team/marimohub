import { describe, expect, it, vi } from 'vitest';
import { createProjectId, createSessionId, createRunId, UserId } from '../../../ids';
import type { IntegrationProbe, SessionRenderContext } from '../../../ports/integrations';
import type { PackageRegistryCredentialProvider } from '../../../ports/packageRegistry';
import { MemoryBucket } from '../../../testing/MemoryBucket';
import { AesGcmSecretCodec } from '../../secrets/AesGcmSecretCodec';
import { OrgIntegrationsStore, ProjectIntegrationsStore } from '../ProjectIntegrationsStore';
import { codeArtifact } from './codeArtifact';
import { defaultRegistry } from './index';

const actor = UserId.parse('user-test');
const config = {
	domain: 'company',
	domain_owner: '123456789012',
	repository: 'python',
	region: 'us-east-1',
	auth: { method: 'token', token: 'existing-token' },
};
const awsConfig = {
	...config,
	auth: { method: 'static', access_key_id: 'KEY', secret_access_key: 'aws-secret' },
};
const context: SessionRenderContext = {
	workload: { kind: 'session', id: createSessionId() },
	principal: { userId: actor, email: 'test@example.com' },
};

function setup() {
	const bucket = new MemoryBucket();
	const resolve = vi.fn<PackageRegistryCredentialProvider['resolve']>(async () => ({
		username: 'aws',
		password: 'fresh-token',
		expiresAt: '2099-01-01T00:00:00.000Z',
	}));
	const fetch = vi.fn<IntegrationProbe['fetch']>(async () => ({
		ok: true,
		status: 200,
		json: async () => ({}),
	}));
	const probe = { fetch, connect: vi.fn() };
	const options = {
		bucket,
		registry: defaultRegistry(),
		codec: new AesGcmSecretCodec({ kek: 'sFjp5R6eWYvc9SGtfeYEsQQlMKB8MfP4FdFAD7JAjsw=' }),
		packageRegistryCredentials: { resolve },
		packageRegistryProbe: probe,
		probe,
	};
	return {
		options,
		bucket,
		resolve,
		probe,
		projectId: createProjectId(),
		project: new ProjectIntegrationsStore(options),
		org: new OrgIntegrationsStore(options),
	};
}

describe('CodeArtifact integration', () => {
	it.each([
		{ domain: 'x/../../evil' },
		{ domain_owner: '123' },
		{ region: 'us-east-1.evil.test' },
		{ repository: 'python?token=secret' },
		{ duration_seconds: 899 },
		{ duration_seconds: 43201 },
	])('rejects invalid repository configuration %j', (invalid) => {
		expect(codeArtifact.configSchema.safeParse({ ...config, ...invalid }).success).toBe(false);
	});

	it('inherits org configuration and keeps credentials out of files and API reads', async () => {
		const s = setup();
		const entry = await s.org.create(
			{ kind: 'aws_codeartifact', name: 'private-registry', config },
			actor,
		);
		const render = await s.project.resolveForSession(s.projectId, context);
		expect(render?.vars).toMatchObject({
			UV_INDEX:
				'private-registry=https://company-123456789012.d.codeartifact.us-east-1.amazonaws.com/pypi/python/simple/',
			UV_INDEX_PRIVATE_REGISTRY_USERNAME: 'aws',
			UV_INDEX_PRIVATE_REGISTRY_PASSWORD: 'existing-token',
		});
		expect(render?.attachments[0]).toMatchObject({ id: entry.id, version: 1 });
		expect(JSON.stringify(render?.files)).not.toContain('existing-token');
		expect(JSON.stringify(await s.org.get(entry.id))).not.toContain('existing-token');
		expect(s.resolve).not.toHaveBeenCalled();
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
			const s = setup();
			await s.project.create(
				s.projectId,
				{
					kind: 'aws_codeartifact',
					name: 'private',
					config: awsConfig,
				},
				actor,
			);
			const workload =
				kind === 'session' ? { kind, id: createSessionId() } : { kind, id: createRunId() };
			const render = await s.project.resolveForSession(s.projectId, { ...context, workload });
			expect(s.resolve).toHaveBeenCalledOnce();
			expect(s.resolve.mock.calls[0][0].auth).toEqual({
				method: 'static',
				access_key_id: 'KEY',
				secret_access_key: 'aws-secret',
			});
			expect(render?.vars.UV_INDEX_PRIVATE_PASSWORD).toBe('fresh-token');
			expect(JSON.stringify(render)).not.toContain('KEY');
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

	it('requires project WIF for inherited federation and passes only the project credentials', async () => {
		const s = setup();
		await s.org.create(
			{
				kind: 'aws_codeartifact',
				name: 'private',
				config: { ...config, auth: { method: 'federation' } },
			},
			actor,
		);
		await expect(s.project.resolveForSession(s.projectId, context)).rejects.toThrow(
			'could not be rendered',
		);
		expect(s.resolve).not.toHaveBeenCalled();
		const credentials = { accessKeyId: 'PROJECT', secretAccessKey: 'project-secret' };
		await s.project.resolveForSession(s.projectId, {
			...context,
			resolveAwsCredentials: async () => credentials,
		});
		expect(s.resolve.mock.calls[0][1].awsCredentials).toEqual(credentials);
	});

	it('merges multiple indexes and rejects competing defaults or custom uv variables', async () => {
		const s = setup();
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
			{ config: { ...config, default_index: false } },
			actor,
		);
		expect(
			(await s.project.resolveForSession(s.projectId, context))?.vars.UV_INDEX.split(' '),
		).toHaveLength(2);
		await s.project.create(
			s.projectId,
			{
				kind: 'custom_env',
				name: 'override',
				config: { vars: { UV_INDEX: 'https://other.example/simple/' } },
			},
			actor,
		);
		await expect(s.project.resolveForSession(s.projectId, context)).rejects.toThrow(
			'same environment variable',
		);
	});

	it('tests repository read access with the resolved token without echoing failures', async () => {
		const s = setup();
		await expect(
			s.project.test(s.projectId, { source: 'draft', kind: 'aws_codeartifact', config }),
		).resolves.toMatchObject({ ok: true });
		expect(s.probe.fetch).toHaveBeenCalledWith(
			'https://company-123456789012.d.codeartifact.us-east-1.amazonaws.com/pypi/python/simple/',
			expect.objectContaining({
				headers: { authorization: `Basic ${btoa('aws:existing-token')}` },
			}),
		);
		s.probe.fetch.mockRejectedValue(new Error('existing-token'));
		const result = await s.project.test(s.projectId, {
			source: 'draft',
			kind: 'aws_codeartifact',
			config,
		});
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain('existing-token');
	});

	it('fails closed if token acquisition fails', async () => {
		const s = setup();
		await s.org.create(
			{
				kind: 'aws_codeartifact',
				name: 'private',
				config: awsConfig,
			},
			actor,
		);
		s.resolve.mockRejectedValue(new Error('aws-secret'));
		await expect(s.project.resolveForSession(s.projectId, context)).rejects.toThrow(
			'Integration "private" could not be rendered.',
		);
	});
});

describe('CodeArtifact failure boundaries', () => {
	it.each(['adapter', 'provisioning probe'] as const)(
		'fails closed without the %s but still supports supplied tokens',
		async (missing) => {
			const s = setup();
			const project = new ProjectIntegrationsStore({
				...s.options,
				...(missing === 'adapter'
					? { packageRegistryCredentials: undefined }
					: { packageRegistryProbe: undefined }),
			});
			const entry = await project.create(
				s.projectId,
				{ kind: 'aws_codeartifact', name: 'private', config: awsConfig },
				actor,
			);
			await expect(project.resolveForSession(s.projectId, context)).rejects.toThrow(
				'could not be rendered',
			);
			for (const auth of [awsConfig.auth, { method: 'federation' }]) {
				await expect(
					project.test(s.projectId, {
						source: 'draft',
						kind: 'aws_codeartifact',
						config: { ...awsConfig, auth },
					}),
				).resolves.toMatchObject({ ok: false });
			}
			expect(s.resolve).not.toHaveBeenCalled();
			expect(s.probe.fetch).not.toHaveBeenCalled();
			await project.update(s.projectId, entry.id, { config }, actor);
			expect(
				(await project.resolveForSession(s.projectId, context))?.vars.UV_INDEX_PRIVATE_PASSWORD,
			).toBe('existing-token');
		},
	);

	it('uses the same authentication probe for connection tests and session rendering', async () => {
		const s = setup();
		const registryProbe = { fetch: vi.fn(), connect: vi.fn() };
		const project = new ProjectIntegrationsStore({
			...s.options,
			packageRegistryProbe: registryProbe,
		});
		await project.create(
			s.projectId,
			{ kind: 'aws_codeartifact', name: 'private', config: awsConfig },
			actor,
		);
		await expect(
			project.test(s.projectId, { source: 'draft', kind: 'aws_codeartifact', config: awsConfig }),
		).resolves.toMatchObject({ ok: true });
		await project.resolveForSession(s.projectId, context);
		expect(s.resolve).toHaveBeenCalledTimes(2);
		for (const [, options] of s.resolve.mock.calls) expect(options.probe).toBe(registryProbe);
		expect(s.probe.fetch).toHaveBeenCalledOnce();
	});

	it('disables connection tests without making an authentication request', async () => {
		const s = setup();
		const project = new ProjectIntegrationsStore({ ...s.options, probe: undefined });
		expect(
			project.listKinds().find((kind) => kind.kind === 'aws_codeartifact')?.supports_test,
		).toBe(false);
		await expect(
			project.test(s.projectId, { source: 'draft', kind: 'aws_codeartifact', config: awsConfig }),
		).rejects.toThrow('Connection testing is not enabled');
		expect(s.resolve).not.toHaveBeenCalled();
		expect(s.probe.fetch).not.toHaveBeenCalled();
	});

	it('does not fall back to another identity after project WIF fails', async () => {
		const s = setup();
		await s.org.create(
			{
				kind: 'aws_codeartifact',
				name: 'private',
				config: { ...config, auth: { method: 'federation' } },
			},
			actor,
		);
		const resolveAwsCredentials = vi.fn(async () => {
			throw new Error('project-secret');
		});
		await expect(
			s.project.resolveForSession(s.projectId, { ...context, resolveAwsCredentials }),
		).rejects.toMatchObject({ message: 'Integration "private" could not be rendered.' });
		expect(resolveAwsCredentials).toHaveBeenCalledOnce();
		expect(s.resolve).not.toHaveBeenCalled();
		expect(s.probe.fetch).not.toHaveBeenCalled();
	});

	it('does not contact AWS when an external secret is unavailable', async () => {
		const s = setup();
		const project = new ProjectIntegrationsStore({
			...s.options,
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
		await project.create(
			s.projectId,
			{
				kind: 'aws_codeartifact',
				name: 'private',
				config: {
					...awsConfig,
					auth: {
						...awsConfig.auth,
						secret_access_key: {
							$secret: { kind: 'reference', backend: 'vault', locator: 'private/locator' },
						},
					},
				},
			},
			actor,
		);
		const error = await project.resolveForSession(s.projectId, context).catch((err: Error) => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toMatch(/secret-value|private\/locator/);
		expect(s.resolve).not.toHaveBeenCalled();
	});

	it.each([401, 403, 404, 429, 503])(
		'reports repository HTTP %s as failure and never exposes the response body',
		async (status) => {
			const s = setup();
			const json = vi.fn(async () => ({ token: 'fresh-token', error: 'aws-secret' }));
			s.probe.fetch.mockResolvedValue({ ok: false, status, json });
			await expect(
				s.project.test(s.projectId, {
					source: 'draft',
					kind: 'aws_codeartifact',
					config: awsConfig,
				}),
			).resolves.toEqual({
				ok: false,
				details: 'Repository access failed. Check the repository and IAM read permissions.',
			});
			expect(s.resolve).toHaveBeenCalledOnce();
			expect(json).not.toHaveBeenCalled();
		},
	);

	it('does not test repository access after token acquisition fails', async () => {
		const s = setup();
		s.resolve.mockRejectedValue(new Error('aws-secret'));
		const result = await s.project.test(s.projectId, {
			source: 'draft',
			kind: 'aws_codeartifact',
			config: awsConfig,
		});
		expect(result.ok).toBe(false);
		expect(result.details).not.toContain('aws-secret');
		expect(s.probe.fetch).not.toHaveBeenCalled();
	});

	it.each(['before authentication', 'after authentication'] as const)(
		'stops a cancelled connection test %s',
		async (timing) => {
			const s = setup();
			const controller = new AbortController();
			if (timing === 'before authentication') controller.abort(new Error('aws-secret'));
			else
				s.resolve.mockImplementation(async () => {
					controller.abort(new Error('aws-secret'));
					return { username: 'aws', password: 'fresh-token' };
				});
			const result = await s.project.test(
				s.projectId,
				{ source: 'draft', kind: 'aws_codeartifact', config: awsConfig },
				undefined,
				{ signal: controller.signal },
			);
			expect(result.ok).toBe(false);
			expect(result.details).not.toMatch(/aws-secret|fresh-token/);
			expect(s.resolve).toHaveBeenCalledTimes(timing === 'before authentication' ? 0 : 1);
			expect(s.probe.fetch).not.toHaveBeenCalled();
		},
	);

	it('rejects competing org and project default indexes', async () => {
		const s = setup();
		await s.org.create(
			{ kind: 'aws_codeartifact', name: 'org', config: { ...config, default_index: true } },
			actor,
		);
		await s.project.create(
			s.projectId,
			{ kind: 'aws_codeartifact', name: 'project', config: { ...config, default_index: true } },
			actor,
		);
		await expect(s.project.resolveForSession(s.projectId, context)).rejects.toThrow(
			'Only one package index can replace PyPI',
		);
	});

	it('rejects a conflicting credential variable without disclosing either value', async () => {
		const s = setup();
		await s.project.create(
			s.projectId,
			{ kind: 'aws_codeartifact', name: 'private', config },
			actor,
		);
		await s.project.create(
			s.projectId,
			{
				kind: 'custom_env',
				name: 'other',
				config: { secrets: [{ name: 'UV_INDEX_PRIVATE_PASSWORD', value: 'conflicting-token' }] },
			},
			actor,
		);
		const error = await s.project
			.resolveForSession(s.projectId, context)
			.catch((err: Error) => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('same environment variable');
		expect((error as Error).message).not.toMatch(/existing-token|conflicting-token/);
	});

	it('rejects a supplied token containing a control character before injection', async () => {
		const s = setup();
		await s.project.create(
			s.projectId,
			{
				kind: 'aws_codeartifact',
				name: 'private',
				config: { ...config, auth: { method: 'token', token: 'secret\ntoken' } },
			},
			actor,
		);
		await expect(s.project.resolveForSession(s.projectId, context)).rejects.toMatchObject({
			message: 'Integration "private" emitted an environment value containing a control character.',
		});
	});
});
