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
		const registry = new ConfiguredSourceControlRegistry([adapter], [adapter], authorize);
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
		const registry = new ConfiguredSourceControlRegistry([publisher], [reader], authorize);
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

	it('returns the original adapters when policies are omitted', () => {
		const adapter = new Provider();
		const registry = new ConfiguredSourceControlRegistry([adapter], [adapter]);
		expect(registry.getReader('test', projectId)).toBe(adapter);
		expect(registry.getPublisher('test', projectId)).toBe(adapter);
		expect(registry.pullSourceProviders()).toEqual(['test']);
	});

	it.each(['reader', 'publisher'])('rejects duplicate %s provider ids', (kind) => {
		const adapters = [new Provider(), new Provider()];
		expect(
			() =>
				new ConfiguredSourceControlRegistry(
					kind === 'publisher' ? adapters : [],
					kind === 'reader' ? adapters : [],
				),
		).toThrow('provider ids must be unique');
	});
});
