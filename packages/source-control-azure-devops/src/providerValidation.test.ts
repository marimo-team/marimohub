import { describe, expect, it, vi } from 'vitest';
import { UnavailableError, ValidationError } from '@marimo-hub/core/errors';
import type { OpenChangeRequestInput } from '@marimo-hub/core/ports/source-control';
import { AzureDevOpsSourceControl } from './index';
import { FakeAzure, repository } from './testing/fakeAzure';

function setup() {
	const fake = new FakeAzure();
	const adapter = new AzureDevOpsSourceControl(
		{ organization: 'acme', credential: { getToken: vi.fn(async () => ({ token: 'token' })) } },
		{ fetcher: fake.fetcher },
	);
	const input: OpenChangeRequestInput = {
		repository,
		baseBranch: 'main',
		baseCommit: fake.base,
		headBranch: 'proposal',
		title: 'Update notebook',
		body: '',
		draft: false,
		changes: [{ path: 'new.py', operation: 'add', content: new Uint8Array([1]) }],
	};
	return { fake, adapter, input };
}

describe('Azure provider commit validation', () => {
	it('classifies a malformed branch head as provider unavailability', async () => {
		const { fake, adapter } = setup();
		fake.refs.set('refs/heads/main', 'invalid');
		await expect(adapter.getBranchHead(repository, 'main')).rejects.toBeInstanceOf(
			UnavailableError,
		);
	});
	it.each(['commitId', 'treeId'])(
		'classifies a malformed %s response as provider unavailability',
		async (field) => {
			const { fake, adapter } = setup();
			fake.fetcher.mockResolvedValueOnce(
				Response.json({ commitId: fake.base, treeId: 'a'.repeat(40), [field]: 'invalid' }),
			);
			await expect(adapter.fetchWorkspace(repository, fake.base, '')).rejects.toBeInstanceOf(
				UnavailableError,
			);
			expect(fake.fetcher).toHaveBeenCalledOnce();
		},
	);
	it('classifies a malformed tree object ID as provider unavailability', async () => {
		const { fake, adapter } = setup();
		fake.fetcher.mockResolvedValueOnce(
			Response.json({ commitId: fake.base, treeId: 'a'.repeat(40) }),
		);
		fake.fetcher.mockResolvedValueOnce(
			Response.json({
				treeEntries: [
					{ relativePath: 'a.py', gitObjectType: 'blob', mode: '100644', objectId: 'invalid' },
				],
			}),
		);
		await expect(adapter.fetchWorkspace(repository, fake.base, '')).rejects.toBeInstanceOf(
			UnavailableError,
		);
		expect(fake.fetcher).toHaveBeenCalledTimes(2);
	});
	it('keeps malformed user commits as validation failures before making requests', async () => {
		const { fake, adapter } = setup();
		await expect(adapter.fetchWorkspace(repository, 'invalid', '')).rejects.toBeInstanceOf(
			ValidationError,
		);
		expect(fake.fetcher).not.toHaveBeenCalled();
	});
	it('rejects a multiline title before making requests', async () => {
		const { fake, adapter, input } = setup();
		await expect(
			adapter.openChangeRequest({ ...input, title: 'First\nSecond' }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(fake.fetcher).not.toHaveBeenCalled();
	});
});
