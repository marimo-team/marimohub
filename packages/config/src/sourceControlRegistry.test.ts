import { describe, expect, it, vi } from 'vitest';
import { ProjectId } from '@marimo-hub/core/ids';
import type {
	OpenChangeRequestInput,
	SourceControlPublisher,
	SourceControlReader,
	UpdateChangeRequestInput,
} from '@marimo-hub/core/ports/source-control';
import { ConfiguredSourceControlRegistry } from './sourceControlRegistry';

const projectId = ProjectId.parse('proj-0000000000000000');
const input: OpenChangeRequestInput = {
	repository: 'team/repo',
	baseBranch: 'main',
	baseCommit: 'abc',
	headBranch: 'change',
	title: 'Change',
	body: '',
	draft: true,
	changes: [],
};

class Provider implements SourceControlReader, SourceControlPublisher {
	readonly provider = 'test';
	private readonly repository = 'team/repo';
	private readonly head = { commit: 'abc' };
	private readonly files = [{ path: 'app.py', bytes: new Uint8Array([1]) }];
	readonly publication = {
		number: 1,
		url: 'https://example.com/pr/1',
		headBranch: 'change',
		headCommit: 'abc',
	};

	supportsRepository(repository: string) {
		return repository === this.repository;
	}
	async getBranchHead() {
		return this.head;
	}
	async fetchWorkspace() {
		return this.files;
	}
	async fetchGitDirectory() {
		return this.files;
	}
	async openChangeRequest(_input: OpenChangeRequestInput) {
		return this.publication;
	}
	async updateChangeRequest(_input: UpdateChangeRequestInput) {
		return this.publication;
	}
}

describe('ConfiguredSourceControlRegistry', () => {
	it('keeps adapter receivers and forwards project authorization for every operation', async () => {
		const adapter = new Provider();
		const authorize = vi.fn();
		const registry = new ConfiguredSourceControlRegistry([
			{ reader: adapter, publisher: adapter, authorize },
		]);
		const reader = registry.getReader('test', projectId)!;
		const publisher = registry.getPublisher('test', projectId)!;
		expect(reader.supportsRepository(input.repository)).toBe(true);
		expect(await reader.getBranchHead(input.repository, 'main')).toEqual({ commit: 'abc' });
		const files = await reader.fetchWorkspace(input.repository, 'abc', '.');
		expect(files).toEqual([{ path: 'app.py', bytes: new Uint8Array([1]) }]);
		expect(await reader.fetchGitDirectory!(input.repository, 'abc', 'main')).toEqual(files);
		expect(await publisher.openChangeRequest(input)).toEqual(adapter.publication);
		expect(
			await publisher.updateChangeRequest!({ ...input, changeRequest: adapter.publication }),
		).toEqual(adapter.publication);
		expect(authorize.mock.calls).toEqual(
			Array.from({ length: 6 }, () => [input.repository, projectId]),
		);
	});

	it('preserves absent capabilities and skips policy checks for unsupported repositories', () => {
		const reader: SourceControlReader = {
			provider: 'read-only',
			supportsRepository: () => false,
			getBranchHead: vi.fn(),
			fetchWorkspace: vi.fn(),
		};
		const publisher: SourceControlPublisher = {
			provider: 'publish-only',
			openChangeRequest: vi.fn(),
		};
		const authorize = vi.fn();
		const registry = new ConfiguredSourceControlRegistry([
			{ publisher, authorize },
			{ reader, authorize },
		]);
		expect(registry.readerProviders()).toEqual(['read-only']);
		expect(registry.publisherProviders()).toEqual(['publish-only']);
		expect(registry.pullSourceProviders()).toEqual([]);
		expect(registry.getReader('read-only')).not.toHaveProperty('fetchGitDirectory');
		expect(registry.getPublisher('publish-only')).not.toHaveProperty('updateChangeRequest');
		expect(registry.getReader('publish-only')).toBeUndefined();
		expect(registry.getPublisher('read-only')).toBeUndefined();
		expect(registry.getReader('read-only')!.supportsRepository('unsupported')).toBe(false);
		expect(authorize).not.toHaveBeenCalled();
	});

	it('authorizes every preview metadata operation against the project repository policy', async () => {
		const adapter = {
			...new Provider(),
			provider: 'github',
			previews: true,
			supportsRepository: () => true,
			getBranchHead: vi.fn(),
			fetchWorkspace: vi.fn(),
			listBranches: vi.fn(),
			listCommits: vi.fn(),
			resolveCommit: vi.fn(),
			getPullRequest: vi.fn(),
		};
		const authorize = vi.fn(() => {
			throw new Error('Repository denied');
		});
		const reader = new ConfiguredSourceControlRegistry([{ reader: adapter, authorize }]).getReader(
			'github',
			projectId,
		)!;
		for (const invoke of [
			() => reader.listBranches!('private/repo', ''),
			() => reader.listCommits!('private/repo', ''),
			() => reader.resolveCommit!('private/repo', 'a'.repeat(40)),
			() => reader.getPullRequest!('private/repo', 1),
		])
			await expect(invoke()).rejects.toThrow('Repository denied');
		expect(authorize).toHaveBeenCalledTimes(4);
		expect(authorize.mock.calls).toEqual(
			Array.from({ length: 4 }, () => ['private/repo', projectId]),
		);
		expect(adapter.listBranches).not.toHaveBeenCalled();
		expect(adapter.getPullRequest).not.toHaveBeenCalled();
	});

	it('returns the original adapters when policies are omitted', () => {
		const adapter = new Provider();
		const registry = new ConfiguredSourceControlRegistry([{ reader: adapter, publisher: adapter }]);
		expect(registry.getReader('test', projectId)).toBe(adapter);
		expect(registry.getPublisher('test', projectId)).toBe(adapter);
		expect(registry.pullSourceProviders()).toEqual(['test']);
	});

	it.each(['reader', 'publisher'])('rejects duplicate %s provider ids', (kind) => {
		const adapters = [new Provider(), new Provider()];
		expect(
			() => new ConfiguredSourceControlRegistry(adapters.map((adapter) => ({ [kind]: adapter }))),
		).toThrow('provider ids must be unique');
	});
});

describe('multiple source-control registrations', () => {
	it('isolates policies and discovers capabilities from each registration', async () => {
		const allowed = new Provider();
		const denied = {
			provider: 'denied',
			supportsRepository: () => true,
			getBranchHead: vi.fn(),
			fetchWorkspace: vi.fn(),
		};
		const authorize = vi.fn(() => {
			throw new Error('Repository denied');
		});
		const registry = new ConfiguredSourceControlRegistry([
			{ reader: allowed, publisher: allowed, repositoryHosts: { 'github.com': 'github' } },
			{ reader: denied, authorize, repositoryHosts: { 'dev.azure.com': 'azure-devops' } },
		]);
		expect(registry.readerProviders()).toEqual(['test', 'denied']);
		expect(registry.publisherProviders()).toEqual(['test']);
		expect(registry.pullSourceProviders()).toEqual(['test']);
		expect(registry.repositoryHosts).toEqual({
			'github.com': 'github',
			'dev.azure.com': 'azure-devops',
		});
		await expect(
			registry.getReader('test', projectId)!.getBranchHead('team/repo', 'main'),
		).resolves.toEqual({ commit: 'abc' });
		await expect(
			registry.getReader('denied', projectId)!.getBranchHead('team/repo', 'main'),
		).rejects.toThrow('Repository denied');
		expect(authorize).toHaveBeenCalledExactlyOnceWith('team/repo', projectId);
		expect(denied.getBranchHead).not.toHaveBeenCalled();
	});
	it('preserves host names that collide with Object prototype properties', () => {
		const registry = new ConfiguredSourceControlRegistry([
			{ repositoryHosts: { ['__proto__']: 'github', constructor: 'gitlab' as const } },
		]);
		expect(Object.entries(registry.repositoryHosts)).toEqual([
			['__proto__', 'github'],
			['constructor', 'gitlab'],
		]);
		expect(JSON.parse(JSON.stringify(registry.repositoryHosts))).toEqual({
			['__proto__']: 'github',
			constructor: 'gitlab',
		});
	});
	it.each(['git.example.com', '__proto__'])('rejects conflicting mappings for %s', (host) => {
		expect(
			() =>
				new ConfiguredSourceControlRegistry([
					{ repositoryHosts: { [host]: 'github' } },
					{ repositoryHosts: { [host]: 'gitlab' } },
				]),
		).toThrow('conflicting providers');
	});
});
