import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectId } from '@marimo-hub/core/ids';
import { makeSourceControl } from './sourceControl';

const repo = 'https://dev.azure.com/acme/analytics/_git/notebooks';
const organization = { MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_ORGANIZATION: 'acme' };
afterEach(() => vi.restoreAllMocks());

describe('Azure source control configuration', () => {
	it('registers Azure without GitHub credentials', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const registry = makeSourceControl(organization).sourceControl!;
		expect(registry.readerProviders()).toEqual(['azure-devops']);
		expect(registry.publisherProviders()).toEqual(['azure-devops']);
		expect(registry.pullSourceProviders()).toEqual(['azure-devops']);
		expect(registry.repositoryHosts).toEqual({ 'dev.azure.com': 'azure-devops' });
		expect(registry.getReader('azure-devops')!.supportsRepository(repo)).toBe(true);
		expect(
			registry.getReader('azure-devops')!.supportsRepository(repo.replace('/acme/', '/other/')),
		).toBe(false);
	});
	it.each([
		{ MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_CLIENT_ID: 'client' },
		{ ...organization, MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_CLIENT_SECRET: 'secret' },
		{ MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_ORGANIZATION: 'https://dev.azure.com/acme' },
	])('rejects incomplete or invalid configuration', (env) => {
		expect(() => makeSourceControl(env)).toThrow('MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_');
	});
	it('checks project policies for both readers and publishers', async () => {
		const project = ProjectId.create();
		const registry = makeSourceControl({
			...organization,
			MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_ALLOWED_REPOSITORIES: JSON.stringify([
				{ resource: repo, projects: [project] },
			]),
		}).sourceControl!;
		expect(registry.getReader('azure-devops', project)!.supportsRepository(repo)).toBe(true);
		expect(() =>
			registry.getReader('azure-devops', ProjectId.create())!.supportsRepository(repo),
		).toThrow('not allowed');
		await expect(registry.getReader('azure-devops')!.getBranchHead(repo, 'main')).rejects.toThrow(
			'not allowed',
		);
		await expect(
			registry.getPublisher('azure-devops')!.openChangeRequest({
				repository: repo,
				baseBranch: 'main',
				baseCommit: 'a'.repeat(40),
				headBranch: 'proposal',
				title: 'Title',
				body: '',
				draft: true,
				changes: [],
			}),
		).rejects.toThrow('not allowed');
	});
	it('keeps GitHub and Azure policies independent in a mixed deployment', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
			.privateKey.export({ type: 'pkcs8', format: 'pem' })
			.toString();
		const registry = makeSourceControl({
			...organization,
			MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_ALLOWED_REPOSITORIES: '[]',
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: key,
		}).sourceControl!;
		expect(registry.pullSourceProviders()).toEqual(['github', 'azure-devops']);
		expect(registry.getReader('github')!.supportsRepository('team/notebooks')).toBe(true);
		expect(() => registry.getReader('azure-devops')!.supportsRepository(repo)).toThrow(
			'not allowed',
		);
	});
	it('rejects allowlist entries outside the configured organization', () => {
		expect(() =>
			makeSourceControl({
				...organization,
				MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_ALLOWED_REPOSITORIES: JSON.stringify([
					{ resource: repo.replace('/acme/', '/other/'), projects: '*' },
				]),
			}),
		).toThrow('ALLOWED_REPOSITORIES');
	});
});
