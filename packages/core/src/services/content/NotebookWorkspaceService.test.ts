import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	MAX_WORKSPACE_BYTES,
	MAX_WORKSPACE_FILE_BYTES,
	MAX_WORKSPACE_FILES,
} from '../../constants';
import { ConflictError, ForbiddenError } from '../../errors';
import { NotebookId, ProjectId, VersionId } from '../../ids';
import type { UserId } from '../../ids';
import { paths } from '../../paths';
import { WorkspaceMutationClaimSchema } from '../../schema';
import type { Source } from '../../schema';
import { fakeNotebookDetail, makeWorkspaceService, MemoryBucket } from '../../testing';
import type { FakeWorkspaceOwner } from '../../testing';
import {
	WORKSPACE_DIRECTORY_MARKER,
	workspaceDirectoryMarkerPath,
} from '../../integrations/remoteWorkspace';
import { WORKSPACE_MUTATION_HEARTBEAT_EVERY } from './NotebookWorkspaceService';
import type { NotebookWorkspaceService } from './NotebookWorkspaceService';

const PROJECT_ID = ProjectId.create();
const NOTEBOOK_ID = NotebookId.create();
const ACTOR = 'user-1' as UserId;
const CLAIM_KEY = paths.project(PROJECT_ID).notebook(NOTEBOOK_ID).workspaceMutationClaim;
const encode = (value: string) => new TextEncoder().encode(value);
const GIT_SOURCE: Source = {
	schema_version: 1,
	type: 'git',
	provider: 'github',
	repo: 'org/repo',
	branch: 'main',
	root_path: '',
	entry_notebook: 'app.py',
	sync_mode: 'push',
	current_version_id: null,
	commit: null,
	last_synced_at: null,
};

class DeleteFailingBucket extends MemoryBucket {
	failDeleteKey: string | null = null;

	override async delete(key: string | string[]): Promise<void> {
		if (typeof key === 'string' && key === this.failDeleteKey) {
			this.failDeleteKey = null;
			throw new Error('delete failed');
		}
		return super.delete(key);
	}
}

class PutFailingBucket extends MemoryBucket {
	failPutKey: string | null = null;

	override async put(...args: Parameters<MemoryBucket['put']>) {
		if (args[0] === this.failPutKey) throw new Error('put failed');
		return super.put(...args);
	}
}

/** Records every lease write and lets a test hijack the lease mid-mutation. */
class ClaimObservingBucket extends MemoryBucket {
	claimWrites: string[] = [];
	stealClaimAfterPuts: number | null = null;
	/** Objects the intruder writes right after taking the lease. */
	intruderWrites: [key: string, value: string][] = [];
	targetPuts = 0;

	override async put(...args: Parameters<MemoryBucket['put']>) {
		const [key, value] = args;
		if (key === CLAIM_KEY) {
			this.claimWrites.push(typeof value === 'string' ? value : new TextDecoder().decode(value));
		} else {
			this.targetPuts++;
			vi.setSystemTime(Date.now() + 1_000);
			if (this.stealClaimAfterPuts !== null && this.targetPuts === this.stealClaimAfterPuts) {
				await super.put(
					CLAIM_KEY,
					JSON.stringify({
						holder: 'intruder',
						expires_at: new Date(Date.now() + 60_000).toISOString(),
					}),
				);
				for (const [intruderKey, intruderValue] of this.intruderWrites) {
					await super.put(intruderKey, intruderValue);
				}
			}
		}
		return super.put(...args);
	}
}

async function readClaim(bucket: MemoryBucket) {
	return WorkspaceMutationClaimSchema.parse(await (await bucket.get(CLAIM_KEY))?.json());
}

describe('NotebookWorkspaceService', () => {
	let bucket: MemoryBucket;
	let owner: FakeWorkspaceOwner;
	let service: NotebookWorkspaceService;

	beforeEach(() => {
		bucket = new MemoryBucket();
		({ service, owner } = makeWorkspaceService(bucket));
	});

	it('lists files and synthetic directories without exposing directory markers', async () => {
		const nb = paths.project(PROJECT_ID).notebook(NOTEBOOK_ID);
		await bucket.put(nb.workspaceFile('notebook.py'), 'print(1)');
		await bucket.put(nb.workspaceFile('data/cars.csv'), 'a,b');
		await service.createDirectory(PROJECT_ID, NOTEBOOK_ID, 'empty');

		const root = await service.list(PROJECT_ID, NOTEBOOK_ID);
		expect(root.items.map((item) => [item.path, item.kind])).toEqual([
			['notebook.py', 'file'],
			['data', 'directory'],
			['empty', 'directory'],
		]);
		expect((await service.list(PROJECT_ID, NOTEBOOK_ID, 'data')).items[0]?.path).toBe(
			'data/cars.csv',
		);
		expect((await service.search(PROJECT_ID, NOTEBOOK_ID, 'empty'))[0]).toMatchObject({
			path: 'empty',
			kind: 'directory',
		});
		const keys = (await bucket.list({ prefix: nb.workspacePrefix })).objects.map(
			(object) => object.key,
		);
		expect(keys).toContain(nb.workspaceFile(`empty/${WORKSPACE_DIRECTORY_MARKER}`));
		expect(keys.every((key) => !key.endsWith('/'))).toBe(true);
		expect((await service.list(PROJECT_ID, NOTEBOOK_ID, 'empty')).items).toEqual([]);
	});

	it('rejects direct access to internal directory marker paths', async () => {
		for (const path of [WORKSPACE_DIRECTORY_MARKER, `data/${WORKSPACE_DIRECTORY_MARKER}`]) {
			await expect(service.read(PROJECT_ID, NOTEBOOK_ID, path)).rejects.toThrow('Reserved');
			await expect(
				service.write(PROJECT_ID, NOTEBOOK_ID, path, encode('poison'), ACTOR),
			).rejects.toThrow('Reserved');
		}
	});

	it('writes, copies, moves, searches, and recursively deletes auxiliary files', async () => {
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'data/a.txt', encode('hello'), ACTOR, true);
		await service.copy(PROJECT_ID, NOTEBOOK_ID, 'data', 'copy');
		await service.move(PROJECT_ID, NOTEBOOK_ID, 'copy/a.txt', 'copy/b.txt');

		expect(
			new TextDecoder().decode((await service.read(PROJECT_ID, NOTEBOOK_ID, 'copy/b.txt')).bytes),
		).toBe('hello');
		expect(
			(await service.search(PROJECT_ID, NOTEBOOK_ID, 'b.txt')).map((item) => item.path),
		).toEqual(['copy/b.txt']);

		await service.delete(PROJECT_ID, NOTEBOOK_ID, 'copy');
		await expect(service.stat(PROJECT_ID, NOTEBOOK_ID, 'copy')).rejects.toThrow('not found');
	});

	it('keeps whitespace-containing paths distinct from protected source paths', async () => {
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'notebook.py', encode('source'), ACTOR);
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'notebook.py ', encode('auxiliary'), ACTOR, true);

		expect(
			new TextDecoder().decode((await service.read(PROJECT_ID, NOTEBOOK_ID, 'notebook.py ')).bytes),
		).toBe('auxiliary');
		expect(
			new TextDecoder().decode((await service.read(PROJECT_ID, NOTEBOOK_ID, 'notebook.py')).bytes),
		).toBe('source');

		await service.delete(PROJECT_ID, NOTEBOOK_ID, 'notebook.py ');
		expect(await service.read(PROJECT_ID, NOTEBOOK_ID, 'notebook.py')).toBeDefined();
	});

	it('routes source edits through the owner and protects their anchor paths', async () => {
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'notebook.py', encode('print(2)'), ACTOR);
		expect(owner.saved).toEqual([
			{
				projectId: PROJECT_ID,
				notebookId: NOTEBOOK_ID,
				path: 'notebook.py',
				content: 'print(2)',
				actor: ACTOR,
			},
		]);
		await expect(service.move(PROJECT_ID, NOTEBOOK_ID, 'notebook.py', 'main.py')).rejects.toThrow(
			ForbiddenError,
		);
		await expect(service.delete(PROJECT_ID, NOTEBOOK_ID, 'pyproject.toml')).rejects.toThrow(
			ForbiddenError,
		);
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'replacement.toml', encode('x = 1'), ACTOR, true);
		await expect(
			service.move(PROJECT_ID, NOTEBOOK_ID, 'replacement.toml', '/pyproject.toml'),
		).rejects.toThrow(ForbiddenError);
		expect(await service.read(PROJECT_ID, NOTEBOOK_ID, 'replacement.toml')).toBeDefined();
	});

	it('protects only root anchors and permits copying them', async () => {
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'notebook.py', encode('print(1)'), ACTOR);
		await service.write(
			PROJECT_ID,
			NOTEBOOK_ID,
			'nested/notebook.py',
			encode('print(2)'),
			ACTOR,
			true,
		);

		await expect(
			service.copy(PROJECT_ID, NOTEBOOK_ID, 'notebook.py', 'backup.py'),
		).resolves.toEqual(expect.objectContaining({ path: 'backup.py' }));
		await expect(
			service.move(PROJECT_ID, NOTEBOOK_ID, 'nested/notebook.py', 'nested/main.py'),
		).resolves.toEqual(expect.objectContaining({ path: 'nested/main.py' }));
		await service.delete(PROJECT_ID, NOTEBOOK_ID, 'nested/main.py');
	});

	it('refuses protected root anchors as copy and directory targets', async () => {
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'backup.py', encode('print(1)'), ACTOR, true);
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'deps.toml', encode('x = 1'), ACTOR, true);

		await expect(service.copy(PROJECT_ID, NOTEBOOK_ID, 'backup.py', 'notebook.py')).rejects.toThrow(
			ForbiddenError,
		);
		await expect(
			service.copy(PROJECT_ID, NOTEBOOK_ID, 'deps.toml', '/pyproject.toml'),
		).rejects.toThrow(ForbiddenError);
		await expect(
			service.createDirectory(PROJECT_ID, NOTEBOOK_ID, 'pyproject.toml'),
		).rejects.toThrow(ForbiddenError);
		await expect(service.createDirectory(PROJECT_ID, NOTEBOOK_ID, 'notebook.py')).rejects.toThrow(
			ForbiddenError,
		);
		expect(owner.saved).toEqual([]);
		await expect(service.stat(PROJECT_ID, NOTEBOOK_ID, 'notebook.py')).rejects.toThrow('not found');
		await expect(service.stat(PROJECT_ID, NOTEBOOK_ID, 'pyproject.toml')).rejects.toThrow(
			'not found',
		);

		await expect(
			service.copy(PROJECT_ID, NOTEBOOK_ID, 'backup.py', 'nested/notebook.py'),
		).resolves.toEqual(expect.objectContaining({ path: 'nested/notebook.py' }));
		await expect(
			service.createDirectory(PROJECT_ID, NOTEBOOK_ID, 'tools/pyproject.toml'),
		).resolves.toEqual(expect.objectContaining({ kind: 'directory' }));
	});

	it('serves the current git version but rejects every mutation', async () => {
		const versionId = VersionId.create();
		owner.detail = fakeNotebookDetail({
			...GIT_SOURCE,
			current_version_id: versionId,
			commit: 'abc',
			last_synced_at: new Date().toISOString(),
		});
		const version = paths.project(PROJECT_ID).notebook(NOTEBOOK_ID).version(versionId);
		await bucket.put(version.workspaceFile('app.py'), 'print(1)');

		expect((await service.list(PROJECT_ID, NOTEBOOK_ID)).items[0]?.path).toBe('app.py');
		await expect(
			service.write(PROJECT_ID, NOTEBOOK_ID, 'app.py', encode('print(2)'), ACTOR),
		).rejects.toThrow('read-only');
	});

	it('treats an unsynced git workspace as empty', async () => {
		owner.detail = fakeNotebookDetail(GIT_SOURCE);

		expect(await service.list(PROJECT_ID, NOTEBOOK_ID)).toEqual({ items: [] });
		expect(await service.search(PROJECT_ID, NOTEBOOK_ID, 'app')).toEqual([]);
		await expect(service.stat(PROJECT_ID, NOTEBOOK_ID, 'app.py')).rejects.toThrow('not found');
		await expect(service.read(PROJECT_ID, NOTEBOOK_ID, 'app.py')).rejects.toThrow('not found');
	});

	it('rejects traversal paths', async () => {
		for (const path of ['../secret', '/data/../../secret', '//server/share', 'data/a\0b']) {
			await expect(service.read(PROJECT_ID, NOTEBOOK_ID, path)).rejects.toThrow(
				'Invalid workspace file path',
			);
		}
	});

	it('paginates directory entries and rejects create and copy collisions', async () => {
		for (const name of ['a.txt', 'b.txt', 'c.txt']) {
			await service.write(PROJECT_ID, NOTEBOOK_ID, name, encode(name), ACTOR, true);
		}

		const first = await service.list(PROJECT_ID, NOTEBOOK_ID, '/', undefined, 2);
		expect(first.items.map((item) => item.name)).toEqual(['a.txt', 'b.txt']);
		expect(first.cursor).toBeTruthy();
		expect(
			(await service.list(PROJECT_ID, NOTEBOOK_ID, '/', first.cursor, 2)).items.map(
				(item) => item.name,
			),
		).toEqual(['c.txt']);
		await expect(
			service.write(PROJECT_ID, NOTEBOOK_ID, 'a.txt', encode('again'), ACTOR, true),
		).rejects.toThrow('already exists');
		await expect(service.copy(PROJECT_ID, NOTEBOOK_ID, 'a.txt', 'b.txt')).rejects.toThrow(
			'already exists',
		);
	});

	it('rejects file-directory collisions and files below non-directories', async () => {
		await service.createDirectory(PROJECT_ID, NOTEBOOK_ID, 'data');
		await expect(
			service.write(PROJECT_ID, NOTEBOOK_ID, 'data', encode('file'), ACTOR, true),
		).rejects.toThrow('already exists');

		await service.write(PROJECT_ID, NOTEBOOK_ID, 'archive', encode('file'), ACTOR, true);
		await expect(service.createDirectory(PROJECT_ID, NOTEBOOK_ID, 'archive')).rejects.toThrow(
			'already exists',
		);
		await expect(
			service.write(PROJECT_ID, NOTEBOOK_ID, 'archive/nested.txt', encode('x'), ACTOR, true),
		).rejects.toThrow('not a directory');
		await expect(
			service.createDirectory(PROJECT_ID, NOTEBOOK_ID, 'archive/nested'),
		).rejects.toThrow('not a directory');
	});

	it('serializes file-directory collisions across service instances', async () => {
		const other = makeWorkspaceService(bucket).service;

		const results = await Promise.allSettled([
			service.createDirectory(PROJECT_ID, NOTEBOOK_ID, 'shared'),
			other.write(PROJECT_ID, NOTEBOOK_ID, 'shared', encode('file'), ACTOR, true),
		]);

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		const nb = paths.project(PROJECT_ID).notebook(NOTEBOOK_ID);
		const fileExists = (await bucket.get(nb.workspaceFile('shared'))) !== null;
		const markerExists =
			(await bucket.get(nb.workspaceFile(workspaceDirectoryMarkerPath('shared')))) !== null;
		expect(fileExists).not.toBe(markerExists);
	});

	it.each([
		[
			'an expired lease',
			() => ({ holder: 'stale', expires_at: new Date(Date.now() - 1).toISOString() }),
		],
		['a legacy expired lease', () => ({ holder: `${VersionId.create()}:${Date.now() - 1}` })],
		['a legacy lease without a readable expiry', () => ({ holder: 'legacy-without-expiry' })],
		['a corrupt body', () => ({ unexpected: true })],
	])('recovers a workspace whose previous mutation claim is %s', async (_label, body) => {
		await bucket.put(CLAIM_KEY, JSON.stringify(body()));

		await expect(
			service.write(PROJECT_ID, NOTEBOOK_ID, 'recovered.txt', encode('ok'), ACTOR, true),
		).resolves.toEqual(expect.objectContaining({ path: 'recovered.txt' }));
		expect(await readClaim(bucket)).toEqual({ holder: null, expires_at: null });
	});

	it.each([
		[
			'a live lease',
			() => ({ holder: 'busy', expires_at: new Date(Date.now() + 60_000).toISOString() }),
		],
		['a live legacy lease', () => ({ holder: `${VersionId.create()}:${Date.now() + 60_000}` })],
	])('waits on %s and then gives up with a conflict', async (_label, body) => {
		vi.useFakeTimers();
		try {
			const claim = body();
			await bucket.put(CLAIM_KEY, JSON.stringify(claim));
			const outcome = service
				.write(PROJECT_ID, NOTEBOOK_ID, 'blocked.txt', encode('no'), ACTOR, true)
				.then(
					() => 'written',
					(error: unknown) => error,
				);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(await outcome).toBeInstanceOf(ConflictError);
			expect(await (await bucket.get(CLAIM_KEY))!.json()).toEqual(claim);
			await expect(service.stat(PROJECT_ID, NOTEBOOK_ID, 'blocked.txt')).rejects.toThrow(
				'not found',
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('re-checks mutability once the lease is held and releases it on rejection', async () => {
		const assertMutable = vi.fn(async () => {
			expect((await readClaim(bucket)).holder).not.toBeNull();
			throw new ConflictError('session started');
		});

		await expect(
			service.write(PROJECT_ID, NOTEBOOK_ID, 'late.txt', encode('x'), ACTOR, true, {
				assertMutable,
			}),
		).rejects.toThrow('session started');
		expect(assertMutable).toHaveBeenCalledTimes(1);
		expect(await readClaim(bucket)).toEqual({ holder: null, expires_at: null });
		await expect(service.stat(PROJECT_ID, NOTEBOOK_ID, 'late.txt')).rejects.toThrow('not found');
	});

	it('renews the lease while copying and deleting many objects', async () => {
		vi.useFakeTimers();
		try {
			const observing = new ClaimObservingBucket();
			service = makeWorkspaceService(observing).service;
			const nb = paths.project(PROJECT_ID).notebook(NOTEBOOK_ID);
			for (let index = 0; index < WORKSPACE_MUTATION_HEARTBEAT_EVERY + 1; index++) {
				await observing.put(nb.workspaceFile(`source/${index}.txt`), 'x');
			}
			observing.claimWrites = [];

			await service.copy(PROJECT_ID, NOTEBOOK_ID, 'source', 'target');
			const claims = observing.claimWrites.map((body) =>
				WorkspaceMutationClaimSchema.parse(JSON.parse(body)),
			);
			expect(claims.map((claim) => claim.holder !== null)).toEqual([true, true, false]);
			const [acquired, renewed] = claims;
			expect(Date.parse(renewed?.expires_at ?? '')).toBeGreaterThan(
				Date.parse(acquired?.expires_at ?? ''),
			);
			expect(renewed?.holder).toBe(acquired?.holder);

			observing.claimWrites = [];
			await service.delete(PROJECT_ID, NOTEBOOK_ID, 'target');
			expect(observing.claimWrites).toHaveLength(3);
			expect((await service.list(PROJECT_ID, NOTEBOOK_ID)).items.map((item) => item.path)).toEqual([
				'source',
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('leaves a partial copy in place when the lease is taken over', async () => {
		vi.useFakeTimers();
		try {
			const observing = new ClaimObservingBucket();
			service = makeWorkspaceService(observing).service;
			const nb = paths.project(PROJECT_ID).notebook(NOTEBOOK_ID);
			for (let index = 0; index < WORKSPACE_MUTATION_HEARTBEAT_EVERY + 1; index++) {
				await observing.put(nb.workspaceFile(`source/${index}.txt`), 'x');
			}
			observing.targetPuts = 0;
			observing.stealClaimAfterPuts = WORKSPACE_MUTATION_HEARTBEAT_EVERY;
			// The new holder overwrites one key the interrupted copy already wrote
			// and adds one of its own; a blind rollback would delete both.
			observing.intruderWrites = [
				[nb.workspaceFile('target/0.txt'), 'intruder'],
				[nb.workspaceFile('target/own.txt'), 'intruder'],
			];

			const copy = service.copy(PROJECT_ID, NOTEBOOK_ID, 'source', 'target');
			await expect(copy).rejects.toThrow(ConflictError);
			await expect(copy).rejects.toThrow('may be partial');
			expect((await readClaim(observing)).holder).toBe('intruder');
			for (const path of ['target/0.txt', 'target/own.txt']) {
				const { bytes } = await service.read(PROJECT_ID, NOTEBOOK_ID, path);
				expect(new TextDecoder().decode(bytes)).toBe('intruder');
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not lose a concurrent child write during a directory move', async () => {
		const other = makeWorkspaceService(bucket).service;
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'source/original.txt', encode('a'), ACTOR, true);

		await Promise.all([
			service.move(PROJECT_ID, NOTEBOOK_ID, 'source', 'target'),
			other.write(PROJECT_ID, NOTEBOOK_ID, 'source/concurrent.txt', encode('b'), ACTOR, true),
		]);

		expect(await service.read(PROJECT_ID, NOTEBOOK_ID, 'target/original.txt')).toBeDefined();
		const locations = await Promise.all([
			service.read(PROJECT_ID, NOTEBOOK_ID, 'source/concurrent.txt').then(
				() => true,
				() => false,
			),
			service.read(PROJECT_ID, NOTEBOOK_ID, 'target/concurrent.txt').then(
				() => true,
				() => false,
			),
		]);
		expect(locations.filter(Boolean)).toHaveLength(1);
	});

	it('copies explicit empty directories without exposing their markers', async () => {
		await service.createDirectory(PROJECT_ID, NOTEBOOK_ID, 'empty');
		expect(await service.copy(PROJECT_ID, NOTEBOOK_ID, 'empty', 'empty-copy')).toEqual({
			path: 'empty-copy',
			name: 'empty-copy',
			kind: 'directory',
		});
		expect(
			(await service.list(PROJECT_ID, NOTEBOOK_ID)).items.map((item) => item.path).sort(),
		).toEqual(['empty', 'empty-copy'].sort());
		expect((await service.list(PROJECT_ID, NOTEBOOK_ID, 'empty-copy')).items).toEqual([]);
		await expect(service.read(PROJECT_ID, NOTEBOOK_ID, 'empty-copy')).rejects.toThrow('not found');
	});

	it('rejects recursive copies and leaves the source unchanged', async () => {
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'data/a.txt', encode('a'), ACTOR, true);

		await expect(service.copy(PROJECT_ID, NOTEBOOK_ID, 'data', 'data/copy')).rejects.toThrow(
			'into itself',
		);
		await expect(service.copy(PROJECT_ID, NOTEBOOK_ID, 'data', 'data')).rejects.toThrow(
			'into itself',
		);
		expect(await service.read(PROJECT_ID, NOTEBOOK_ID, 'data/a.txt')).toBeDefined();
	});

	it('deletes an exact directory prefix without touching a similarly named sibling', async () => {
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'data/a.txt', encode('a'), ACTOR, true);
		await service.write(PROJECT_ID, NOTEBOOK_ID, 'database/b.txt', encode('b'), ACTOR, true);

		await service.delete(PROJECT_ID, NOTEBOOK_ID, 'data');
		await expect(service.read(PROJECT_ID, NOTEBOOK_ID, 'data/a.txt')).rejects.toThrow('not found');
		expect(
			new TextDecoder().decode(
				(await service.read(PROJECT_ID, NOTEBOOK_ID, 'database/b.txt')).bytes,
			),
		).toBe('b');
	});

	it('rolls back partial directory copies when a destination write fails', async () => {
		const failingBucket = new PutFailingBucket();
		service = makeWorkspaceService(failingBucket).service;
		const nb = paths.project(PROJECT_ID).notebook(NOTEBOOK_ID);
		await failingBucket.put(nb.workspaceFile('source/a.txt'), 'a');
		await failingBucket.put(nb.workspaceFile('source/b.txt'), 'b');
		failingBucket.failPutKey = nb.workspaceFile('target/b.txt');

		await expect(service.copy(PROJECT_ID, NOTEBOOK_ID, 'source', 'target')).rejects.toThrow(
			'put failed',
		);
		expect(await service.read(PROJECT_ID, NOTEBOOK_ID, 'source/a.txt')).toBeDefined();
		await expect(service.stat(PROJECT_ID, NOTEBOOK_ID, 'target')).rejects.toThrow('not found');
	});

	it('rejects invalid UTF-8 source edits before calling the source owner', async () => {
		await expect(
			service.write(PROJECT_ID, NOTEBOOK_ID, 'notebook.py', Uint8Array.from([0xc3, 0x28]), ACTOR),
		).rejects.toThrow('valid UTF-8');
		expect(owner.saved).toEqual([]);
	});

	it('enforces per-file, total-byte, and file-count limits', async () => {
		await expect(
			service.write(
				PROJECT_ID,
				NOTEBOOK_ID,
				'too-large.bin',
				new Uint8Array(MAX_WORKSPACE_FILE_BYTES + 1),
				ACTOR,
			),
		).rejects.toThrow(`${MAX_WORKSPACE_FILE_BYTES} bytes`);

		const fullFile = new Uint8Array(MAX_WORKSPACE_FILE_BYTES);
		for (let index = 0; index < MAX_WORKSPACE_BYTES / MAX_WORKSPACE_FILE_BYTES; index++) {
			await bucket.put(
				paths.project(PROJECT_ID).notebook(NOTEBOOK_ID).workspaceFile(`large-${index}.bin`),
				fullFile,
			);
		}
		await expect(
			service.write(PROJECT_ID, NOTEBOOK_ID, 'one-too-many.bin', new Uint8Array(1), ACTOR),
		).rejects.toThrow(`${MAX_WORKSPACE_BYTES} bytes`);

		bucket = new MemoryBucket();
		service = makeWorkspaceService(bucket).service;
		const prefix = paths.project(PROJECT_ID).notebook(NOTEBOOK_ID).workspacePrefix;
		await Promise.all(
			Array.from({ length: MAX_WORKSPACE_FILES }, (_, index) =>
				bucket.put(`${prefix}file-${index}.txt`, new Uint8Array()),
			),
		);
		await expect(
			service.write(PROJECT_ID, NOTEBOOK_ID, 'overflow.txt', new Uint8Array(), ACTOR),
		).rejects.toThrow(`${MAX_WORKSPACE_FILES} files`);
	});

	it('removes the copied destination when a move cannot delete its source', async () => {
		const failingBucket = new DeleteFailingBucket();
		service = makeWorkspaceService(failingBucket).service;
		const sourceKey = paths.project(PROJECT_ID).notebook(NOTEBOOK_ID).workspaceFile('source.txt');
		await failingBucket.put(sourceKey, 'keep me');
		failingBucket.failDeleteKey = sourceKey;

		await expect(
			service.move(PROJECT_ID, NOTEBOOK_ID, 'source.txt', 'destination.txt'),
		).rejects.toThrow('delete failed');
		expect(await service.read(PROJECT_ID, NOTEBOOK_ID, 'source.txt')).toBeDefined();
		await expect(service.read(PROJECT_ID, NOTEBOOK_ID, 'destination.txt')).rejects.toThrow(
			'not found',
		);
	});
});
