import { expect, it } from 'vitest';
import { workingBranchFixture } from './workingBranches';

it('rejects an unknown commit instead of preparing an empty tree', async () => {
	const env = await workingBranchFixture();
	await expect(
		env.writer.prepareCommit({
			repository: 'owner/repo',
			parentCommit: 'missing',
			message: 'Update',
			changes: [],
		}),
	).rejects.toThrow('Unknown parent commit: missing');
	expect(env.snapshots.size).toBe(1);
});

it('keeps branch tips independent across creation, publication, and external moves', async () => {
	const { writer, reader, setHead } = await workingBranchFixture();
	for (const branch of ['one', 'two']) {
		await writer.createBranch({ repository: 'owner/repo', branch, fromCommit: 'base' });
	}
	const { commit } = await writer.prepareCommit({
		repository: 'owner/repo',
		parentCommit: 'base',
		message: 'Update',
		changes: [],
	});
	await writer.advanceBranch({
		repository: 'owner/repo',
		branch: 'one',
		expectedHead: 'base',
		commit,
	});
	setHead('external', 'two');
	for (const [branch, expected] of [
		['main', 'base'],
		['one', commit],
		['two', 'external'],
	]) {
		expect(await reader.getBranchHead('owner/repo', branch)).toEqual({ commit: expected });
		expect(
			await writer.inspectBranch({ repository: 'owner/repo', branch, commit: expected }),
		).toMatchObject({ headCommit: expected, containsCommit: true });
	}
	await expect(
		writer.advanceBranch({ repository: 'owner/repo', branch: 'one', expectedHead: 'base', commit }),
	).rejects.toThrow('moved');
	await expect(reader.getBranchHead('owner/repo', 'missing')).rejects.toThrow('Unknown branch');
	expect(await writer.inspectBranch({ repository: 'owner/repo', branch: 'missing' })).toMatchObject(
		{ headCommit: null, containsCommit: false },
	);
});

it('returns subtree-relative workspace paths without sibling files', async () => {
	const { reader, snapshots } = await workingBranchFixture();
	const bytes = new TextEncoder().encode('source');
	snapshots.set(
		'nested',
		new Map([
			['apps/app.py', bytes],
			['apps/lib/util.py', bytes],
			['apps-other/secret.py', bytes],
			['root.py', bytes],
		]),
	);
	expect(await reader.fetchWorkspace('owner/repo', 'nested', 'apps')).toEqual([
		{ path: 'app.py', bytes },
		{ path: 'lib/util.py', bytes },
	]);
	expect(await reader.fetchWorkspace('owner/repo', 'nested', '')).toHaveLength(4);
	expect(await reader.fetchWorkspace('owner/repo', 'nested', 'missing')).toEqual([]);
	await expect(reader.fetchWorkspace('owner/repo', 'missing', '')).rejects.toThrow(
		'Unknown commit',
	);
});
