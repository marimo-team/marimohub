import { describe, expect, it, vi } from 'vitest';
import type { SecretResolver } from '../../../ports/secrets';
import { createRunId, createSessionId } from '../../../ids';
import { ProjectIntegrationsStore } from '../ProjectIntegrationsStore';
import { basicAuthHeader } from '../sdk';
import { actor, context, fixture, packageIndexStores } from './packageIndexTestkit';
import {
	artifactory,
	azureArtifacts,
	gitlabPackages,
	pythonPackageIndex,
} from './pythonPackageIndexes';

const cases = [
	{
		kind: 'python_package_index',
		url: 'https://packages.example.test/simple/',
		username: 'reader',
		password: 'index-password',
	},
	{
		kind: 'jfrog_artifactory',
		url: 'https://company.jfrog.io/artifactory/api/pypi/python/simple/',
		username: '',
		password: 'artifactory-token',
	},
	{
		kind: 'azure_artifacts',
		url: 'https://pkgs.dev.azure.com/company/analytics/_packaging/python/pypi/simple/',
		username: 'dummy',
		password: 'azure-pat',
	},
	{
		kind: 'gitlab_packages',
		url: 'https://gitlab.com/api/v4/projects/123/packages/pypi/simple/',
		username: 'gitlab+deploy-token-1',
		password: 'gitlab-token',
	},
];

const setup = () =>
	packageIndexStores({ packageRegistryCredentials: undefined, packageRegistryProbe: undefined });

function withSecret(kind: string, value: unknown): Record<string, unknown> {
	const config = fixture(kind);
	return {
		...config,
		auth: {
			...(config.auth as Record<string, unknown>),
			[kind === 'python_package_index' ? 'password' : 'token']: value,
		},
	};
}

describe.each(cases)('$kind', ({ kind, url, username, password }) => {
	it.each(['session', 'job-run'] as const)(
		'inherits org credentials for a %s without an AWS adapter or probe',
		async (workloadKind) => {
			const s = setup();
			const project = new ProjectIntegrationsStore({ ...s.options, probe: undefined });
			const entry = await s.org.create(
				{ kind, name: 'private-registry', config: fixture(kind) },
				actor,
			);
			const workload =
				workloadKind === 'session'
					? { kind: workloadKind, id: createSessionId() }
					: { kind: workloadKind, id: createRunId() };
			const rendered = await project.resolveForSession(s.projectId, { ...context, workload });
			expect(rendered?.vars).toMatchObject({
				UV_INDEX: `private-registry=${url}`,
				UV_INDEX_PRIVATE_REGISTRY_USERNAME: username,
				UV_INDEX_PRIVATE_REGISTRY_PASSWORD: password,
			});
			expect(JSON.stringify(rendered?.files)).not.toContain(password);
			expect(JSON.stringify(await s.org.get(entry.id))).not.toContain(password);
			expect(s.fetch).not.toHaveBeenCalled();
			const override = await project.create(
				s.projectId,
				{ kind, name: 'private-registry', config: fixture(kind) },
				actor,
			);
			await project.update(s.projectId, override.id, { enabled: false }, actor);
			expect((await project.resolveForSession(s.projectId, context))?.attachments ?? []).toEqual(
				[],
			);
		},
	);

	it('tests read access with the provider credentials', async () => {
		const s = setup();
		const request = { source: 'draft' as const, kind, config: fixture(kind) };
		expect(await s.project.test(s.projectId, request)).toMatchObject({ ok: true });
		expect(s.fetch).toHaveBeenCalledWith(
			url,
			expect.objectContaining({ headers: { Authorization: basicAuthHeader(username, password) } }),
		);
	});

	it.each([301, 302, 401, 403, 404, 429, 500, 503])(
		'rejects HTTP %s without consuming the response or retrying elsewhere',
		async (status) => {
			const s = setup();
			const json = vi.fn(async () => ({ redirect: 'https://other.example/', secret: password }));
			s.fetch.mockResolvedValue({ ok: false, status, json });
			const result = await s.project.test(s.projectId, {
				source: 'draft',
				kind,
				config: fixture(kind),
			});
			expect(result).toEqual({
				ok: false,
				details:
					'Repository access failed. Check the URL, credentials, and package read permissions.',
			});
			expect(json).not.toHaveBeenCalled();
			expect(s.fetch).toHaveBeenCalledOnce();
			expect(s.fetch.mock.calls[0][0]).toBe(url);
		},
	);

	it.each(['Error', 'AbortError', 'TimeoutError'])(
		'sanitizes %s from the network probe',
		async (name) => {
			const s = setup();
			s.fetch.mockRejectedValue(
				name === 'Error'
					? new Error(`${password} ${basicAuthHeader(username, password)}`)
					: new DOMException(`${password} ${basicAuthHeader(username, password)}`, name),
			);
			const result = await s.project.test(s.projectId, {
				source: 'draft',
				kind,
				config: fixture(kind),
			});
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toContain(password);
			expect(JSON.stringify(result)).not.toContain(basicAuthHeader(username, password));
		},
	);

	it('does not report success when cancellation races with the probe response', async () => {
		const s = setup();
		const controller = new AbortController();
		s.fetch.mockImplementation(async (_url, options) => {
			expect(options?.signal).toBe(controller.signal);
			controller.abort(new Error(password));
			return { ok: true, status: 200, json: async () => ({}) };
		});
		const result = await s.project.test(
			s.projectId,
			{ source: 'draft', kind, config: fixture(kind) },
			undefined,
			{ signal: controller.signal },
		);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain(password);
	});

	it('fails closed when an external secret becomes unavailable', async () => {
		const s = setup();
		const resolve = vi.fn<SecretResolver['resolve']>(async () => password);
		const project = new ProjectIntegrationsStore({
			...s.options,
			resolvers: [
				{
					backend: 'vault',
					title: 'Vault',
					locatorPlaceholder: 'path',
					locatorHelp: 'Secret path',
					resolve,
				},
			],
		});
		const config = withSecret(kind, {
			$secret: { kind: 'reference', backend: 'vault', locator: 'private/registry' },
		});
		const entry = await project.create(s.projectId, { kind, name: 'private', config }, actor);
		expect(
			(await project.resolveForSession(s.projectId, context))?.vars.UV_INDEX_PRIVATE_PASSWORD,
		).toBe(password);
		resolve.mockRejectedValue(new Error(`${password} private/registry`));
		for (const operation of [
			() => project.resolveForSession(s.projectId, context),
			() => project.test(s.projectId, { source: 'stored', id: entry.id }),
			() => project.test(s.projectId, { source: 'draft', kind, config }),
		]) {
			const error = await operation().catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain(password);
			expect((error as Error).message).not.toContain('private/registry');
		}
		expect(s.fetch).not.toHaveBeenCalled();
	});

	it('uses rotated credentials for new workloads and stored connection tests', async () => {
		const s = setup();
		const entry = await s.project.create(
			s.projectId,
			{ kind, name: 'private', config: fixture(kind) },
			actor,
		);
		const before = await s.project.resolveForSession(s.projectId, context);
		const nextPassword = 'rotated-registry-secret';
		await s.project.update(
			s.projectId,
			entry.id,
			{ config: withSecret(kind, nextPassword) },
			actor,
		);
		expect(before?.vars.UV_INDEX_PRIVATE_PASSWORD).toBe(password);
		const after = await s.project.resolveForSession(s.projectId, context);
		expect(after?.vars.UV_INDEX_PRIVATE_PASSWORD).toBe(nextPassword);
		expect(JSON.stringify(after)).not.toContain(password);
		expect(JSON.stringify(after?.files)).not.toContain(nextPassword);
		expect(JSON.stringify(await s.project.get(s.projectId, entry.id))).not.toContain(nextPassword);
		await s.project.test(s.projectId, { source: 'stored', id: entry.id });
		expect(s.fetch.mock.calls[0][1]?.headers).toEqual({
			Authorization: basicAuthHeader(username, nextPassword),
		});
	});

	it.each(['secret\rvalue', 'secret\nvalue', 'secret\0value', 'secret\u007fvalue'])(
		'rejects control characters in resolved credentials (%j)',
		async (value) => {
			const s = setup();
			const config = withSecret(kind, value);
			await s.project.create(s.projectId, { kind, name: 'private', config }, actor);
			await expect(s.project.resolveForSession(s.projectId, context)).rejects.toThrow(
				'could not be rendered',
			);
			await expect(s.project.test(s.projectId, { source: 'draft', kind, config })).rejects.toThrow(
				'must not contain control characters',
			);
			expect(s.fetch).not.toHaveBeenCalled();
		},
	);

	it('disables testing without a probe and stops cancelled tests before network access', async () => {
		const s = setup();
		const project = new ProjectIntegrationsStore({ ...s.options, probe: undefined });
		expect(project.listKinds().find((entry) => entry.kind === kind)?.supports_test).toBe(false);
		const request = { source: 'draft' as const, kind, config: fixture(kind) };
		await expect(project.test(s.projectId, request)).rejects.toThrow(
			'Connection testing is not enabled',
		);
		const signal = AbortSignal.abort(new Error(password));
		expect(await s.project.test(s.projectId, request, undefined, { signal })).toMatchObject({
			ok: false,
		});
		expect(s.fetch).not.toHaveBeenCalled();
	});
});

describe('Python package index configuration', () => {
	it.each([
		'http://packages.example/simple/',
		'https://user:secret@packages.example/simple/',
		'https://packages.example/simple/?token=secret',
		'https://packages.example/simple/#secret',
		'https:///packages.example/simple/',
		'https://packages.example:65536/simple/',
		'https://packages.example:0/simple/',
		'https://packages.example/with space/',
		'https://packages.example\\other/simple/',
		'https://packages.example/simple/\n',
		'https://packages.example/simple/\r',
		'https://packages.example/simple/\u007f',
	])('rejects unsafe or ambiguous URLs: %s', (url) => {
		for (const definition of [pythonPackageIndex, artifactory, gitlabPackages]) {
			expect(definition.configSchema.safeParse({ ...fixture(definition.kind), url }).success).toBe(
				false,
			);
		}
	});

	it.each(['.', '..', '../other', 'python?token=value', 'python#fragment', '%2e%2e', 'py\\thon'])(
		'rejects path injection: %s',
		(value) => {
			expect(
				artifactory.configSchema.safeParse({ ...fixture(artifactory.kind), repository: value })
					.success,
			).toBe(false);
			for (const field of ['organization', 'project', 'feed']) {
				expect(
					azureArtifacts.configSchema.safeParse({ ...fixture(azureArtifacts.kind), [field]: value })
						.success,
				).toBe(false);
			}
			expect(
				gitlabPackages.configSchema.safeParse({ ...fixture(gitlabPackages.kind), scope_id: value })
					.success,
			).toBe(false);
		},
	);

	it.each(['reader:admin', 'reader\n', 'reader\0', 'reader\u007f'])(
		'rejects invalid Basic usernames (%j) before saving or probing',
		async (username) => {
			const s = setup();
			const config = {
				...fixture('python_package_index'),
				auth: { method: 'basic', username, password: 'secret' },
			};
			await expect(
				s.project.create(
					s.projectId,
					{ kind: 'python_package_index', name: 'private', config },
					actor,
				),
			).rejects.toThrow();
			await expect(
				s.project.test(s.projectId, { source: 'draft', kind: 'python_package_index', config }),
			).rejects.toThrow();
			expect(s.fetch).not.toHaveBeenCalled();
			expect(await s.project.list(s.projectId)).toEqual([]);
		},
	);

	it.each(['0', '-1', '1.5', '1e3', ' 123', '123 ', '123/456', '00123'])(
		'rejects invalid GitLab IDs (%s)',
		(scope_id) => {
			expect(
				gitlabPackages.configSchema.safeParse({ ...fixture('gitlab_packages'), scope_id }).success,
			).toBe(false);
		},
	);

	it('exports the empty Artifactory token username instead of dropping it', async () => {
		const s = setup();
		await s.project.create(
			s.projectId,
			{ kind: 'jfrog_artifactory', name: 'private', config: fixture('jfrog_artifactory') },
			actor,
		);
		const vars = (await s.project.resolveForSession(s.projectId, context))?.vars ?? {};
		expect(Object.hasOwn(vars, 'UV_INDEX_PRIVATE_USERNAME')).toBe(true);
		expect(vars.UV_INDEX_PRIVATE_USERNAME).toBe('');
	});

	it('removes credentials when a generic index switches to anonymous authentication', async () => {
		const s = setup();
		const entry = await s.project.create(
			s.projectId,
			{ kind: 'python_package_index', name: 'private', config: fixture('python_package_index') },
			actor,
		);
		await s.project.update(
			s.projectId,
			entry.id,
			{ config: { ...fixture('python_package_index'), auth: { method: 'none' } } },
			actor,
		);
		const rendered = await s.project.resolveForSession(s.projectId, context);
		expect(rendered?.vars.UV_INDEX_PRIVATE_PASSWORD).toBeUndefined();
		expect(rendered?.vars.UV_INDEX_PRIVATE_USERNAME).toBeUndefined();
		await s.project.test(s.projectId, { source: 'stored', id: entry.id });
		expect(s.fetch.mock.calls[0][1]?.headers).toEqual({});
	});

	it('supports an unauthenticated index without exporting or sending credentials', async () => {
		const s = setup();
		const config = { url: 'https://packages.example/simple/' };
		await s.project.create(
			s.projectId,
			{ kind: 'python_package_index', name: 'public', config },
			actor,
		);
		const rendered = await s.project.resolveForSession(s.projectId, context);
		expect(rendered?.vars.UV_INDEX).toBe('public=https://packages.example/simple/');
		expect(
			Object.keys(rendered?.vars ?? {}).filter((name) => name.startsWith('UV_INDEX_PUBLIC_')),
		).toEqual([]);
		await s.project.test(s.projectId, { source: 'draft', kind: 'python_package_index', config });
		expect(s.fetch).toHaveBeenCalledWith(config.url, expect.objectContaining({ headers: {} }));
	});

	it.each([
		{
			kind: 'azure_artifacts',
			config: { ...fixture('azure_artifacts'), project: undefined, feed: 'Python Feed' },
			url: 'https://pkgs.dev.azure.com/company/_packaging/Python%20Feed/pypi/simple/',
		},
		{
			kind: 'azure_artifacts',
			config: { ...fixture('azure_artifacts'), project: 'Data Science' },
			url: 'https://pkgs.dev.azure.com/company/Data%20Science/_packaging/python/pypi/simple/',
		},
		{
			kind: 'gitlab_packages',
			config: {
				...fixture('gitlab_packages'),
				url: 'https://gitlab.example/gitlab/',
				scope: 'group',
			},
			url: 'https://gitlab.example/gitlab/api/v4/groups/123/-/packages/pypi/simple/',
		},
		{
			kind: 'jfrog_artifactory',
			config: {
				...fixture('jfrog_artifactory'),
				url: 'https://packages.example/custom/artifactory/',
			},
			url: 'https://packages.example/custom/artifactory/api/pypi/python/simple/',
		},
	])('builds provider URLs for $kind', async ({ kind, config, url }) => {
		const s = setup();
		await s.project.create(s.projectId, { kind, name: 'private', config }, actor);
		expect((await s.project.resolveForSession(s.projectId, context))?.vars.UV_INDEX).toBe(
			`private=${url}`,
		);
		await s.project.test(s.projectId, { source: 'draft', kind, config });
		expect(s.fetch.mock.calls[0][0]).toBe(url);
	});

	describe.each([
		{
			kind: 'jfrog_artifactory',
			base: 'https://packages.example',
			path: '/api/pypi/python/simple/',
		},
		{
			kind: 'jfrog_artifactory',
			base: 'https://packages.example/custom/artifactory',
			path: '/api/pypi/python/simple/',
		},
		{
			kind: 'gitlab_packages',
			base: 'https://gitlab.example',
			path: '/api/v4/projects/123/packages/pypi/simple/',
		},
		{
			kind: 'gitlab_packages',
			base: 'https://gitlab.example/custom/gitlab',
			path: '/api/v4/projects/123/packages/pypi/simple/',
		},
	])('$kind base URL $base', ({ kind, base, path }) => {
		it.each(['', '/', '///'])(
			'normalizes the trailing suffix %j for rendering and probes',
			async (suffix) => {
				const s = setup();
				const config = { ...fixture(kind), url: `${base}${suffix}` };
				const entry = await s.project.create(s.projectId, { kind, name: 'private', config }, actor);
				expect((await s.project.resolveForSession(s.projectId, context))?.vars.UV_INDEX).toBe(
					`private=${base}${path}`,
				);
				expect(await s.project.test(s.projectId, { source: 'stored', id: entry.id })).toMatchObject(
					{ ok: true },
				);
				expect(s.fetch.mock.calls[0][0]).toBe(`${base}${path}`);
			},
		);
	});

	it.each(['python_package_index', 'jfrog_artifactory'])(
		'supports UTF-8 basic credentials for %s',
		async (kind) => {
			const s = setup();
			const config = {
				...fixture(kind),
				auth: { method: 'basic', username: 'césar', password: 'pässwörd' },
			};
			await s.project.create(s.projectId, { kind, name: 'private', config }, actor);
			expect(
				(await s.project.resolveForSession(s.projectId, context))?.vars.UV_INDEX_PRIVATE_PASSWORD,
			).toBe('pässwörd');
			await s.project.test(s.projectId, { source: 'draft', kind, config });
			expect(s.fetch.mock.calls[0][1]?.headers).toEqual({
				Authorization: 'Basic Y8Opc2FyOnDDpHNzd8O2cmQ=',
			});
		},
	);

	it('combines providers with CodeArtifact and rejects competing defaults', async () => {
		const s = packageIndexStores();
		await s.org.create(
			{ kind: 'aws_codeartifact', name: 'aws', config: fixture('aws_codeartifact') },
			actor,
		);
		for (const { kind } of cases) {
			await s.project.create(
				s.projectId,
				{
					kind,
					name: kind.replaceAll('_', '-'),
					config: { ...fixture(kind), default_index: kind === 'python_package_index' },
				},
				actor,
			);
		}
		const rendered = await s.project.resolveForSession(s.projectId, context);
		expect(rendered?.vars.UV_INDEX.split(' ')).toHaveLength(4);
		expect(rendered?.vars.UV_DEFAULT_INDEX).toBe(
			'python-package-index=https://packages.example.test/simple/',
		);
		const extra = await s.project.create(
			s.projectId,
			{
				kind: 'python_package_index',
				name: 'extra',
				config: { ...fixture('python_package_index'), default_index: true },
			},
			actor,
		);
		await expect(s.project.resolveForSession(s.projectId, context)).rejects.toThrow(
			'Only one package index can replace PyPI',
		);
		await s.project.update(s.projectId, extra.id, { enabled: false }, actor);
		await s.project.create(
			s.projectId,
			{
				kind: 'custom_env',
				name: 'custom',
				config: { vars: { UV_INDEX: 'legacy=https://other.example/simple/' } },
			},
			actor,
		);
		const merged = (await s.project.resolveForSession(s.projectId, context))?.vars.UV_INDEX;
		expect(merged?.split(' ')).toHaveLength(5);
		expect(merged).toMatch(/ legacy=https:\/\/other\.example\/simple\/$/);
		await s.project.create(
			s.projectId,
			{
				kind: 'custom_env',
				name: 'credentials',
				config: { secrets: [{ name: 'UV_INDEX_AWS_PASSWORD', value: 'conflicting-token' }] },
			},
			actor,
		);
		const error = await s.project
			.resolveForSession(s.projectId, context)
			.catch((err: Error) => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('same environment variable');
		expect((error as Error).message).not.toMatch(/fresh-token|conflicting-token/);
	});
});
