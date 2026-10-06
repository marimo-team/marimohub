import { execResult, readFileFailure } from '../../ports/sandbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId, createVersionId } from '../../ids';
import { NotFoundError } from '../../errors';
import { paths } from '../../paths';
import type { FilesystemSnapshots, SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { Session } from '../../schema';
import {
	ACTOR,
	fakeComputeFrom,
	makeFakeSandbox,
	makeLocalSource,
	makeNotebookMeta,
	makeSession,
	makeVersion,
	MemoryBucket,
	uid,
} from '../../testing';
import { CatalogService } from '../catalog/CatalogService';
import { resolveRestoreSnapshot } from '../content/filesystemSnapshots';
import { NotebookService } from '../content/NotebookService';
import { SandboxProvisioner } from './SandboxProvisioner';
import { SessionRetirer } from './SessionRetirer';
import { SessionService } from './SessionService';
import * as thumbnailCapture from './captureThumbnail';
import { marimoSurface } from './surfaces/marimo';
import { SurfaceManager } from './surfaces/SurfaceManager';
import { SurfaceRegistry } from './surfaces/registry';
import { vscodeSurface } from './surfaces/vscode';

function snapshotProvider(
	instance: SandboxInstance,
	opts: { failCapture?: boolean } = {},
): SandboxProvider & FilesystemSnapshots {
	return {
		filesystemSnapshotsEnabled: true,
		create: () => instance,
		proxy: async () => null,
		createFromSnapshot: () => instance,
		captureSnapshot: async () => {
			if (opts.failCapture) throw new Error('snapshot unavailable');
			return { snapshotId: 'snapshot-after-takeover' };
		},
		deleteSnapshot: async () => {},
	};
}

describe('SessionRetirer', () => {
	let bucket: MemoryBucket;
	let sessions: SessionService;
	let notebooks: NotebookService;
	const projectId = createProjectId();
	const notebookId = createNotebookId();

	beforeEach(async () => {
		bucket = new MemoryBucket();
		sessions = new SessionService(bucket);
		notebooks = new NotebookService(bucket, new CatalogService(bucket));
		const meta = makeNotebookMeta({ id: notebookId, project_id: projectId });
		await bucket.put(paths.project(projectId).notebook(notebookId).meta, JSON.stringify(meta));
		vi.spyOn(notebooks, 'getNotebook').mockResolvedValue({
			meta,
			source: makeLocalSource(),
			readme: null,
		});
		vi.spyOn(notebooks, 'commitSession').mockResolvedValue(null);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function persistentSession(overrides: Partial<Session> = {}): Promise<Session> {
		const session = makeSession({
			project_id: projectId,
			notebook_id: notebookId,
			sandbox_id: createSandboxId(),
			editor_sandbox_sharing: 'exclusive',
			...overrides,
		});
		await bucket.put(paths.session(projectId, session.session_id), JSON.stringify(session));
		await sessions.claimEditor(projectId, notebookId, session.session_id, 'exclusive');
		return session;
	}

	function expiredEditor(overrides: Partial<Session> = {}) {
		return persistentSession({
			status: 'expired',
			sandbox_url: 'https://kernel.example',
			started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
			...overrides,
		});
	}

	function retirer(compute: SandboxProvider): SessionRetirer {
		return new SessionRetirer({
			sessions,
			notebooks,
			compute,
			bucket,
			persistWorkspace: 'source',
		});
	}

	async function reserveTakeover(session: Session, takeoverId: string): Promise<void> {
		await sessions.reserveTakeover(projectId, notebookId, {
			takeoverId,
			requestedBy: uid('user_01HXY00000000000000000001'),
			expectedHolder: session.session_id,
			expectedActivity: 'idle',
		});
	}

	it.each([true, false])(
		'captures a thumbnail only after save and before destruction (enabled=%s)',
		async (enabled) => {
			const { instance } = makeFakeSandbox();
			const order: string[] = [];
			vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockImplementation(async () => {
				order.push('save');
				return true;
			});
			vi.spyOn(thumbnailCapture, 'captureThumbnail').mockImplementation(async () => {
				order.push('thumbnail');
			});
			vi.spyOn(instance, 'destroy').mockImplementation(async () => {
				order.push('destroy');
			});
			const session = await persistentSession();
			await sessions.beginTerminating(projectId, session.session_id);
			await new SessionRetirer({
				sessions,
				notebooks,
				compute: fakeComputeFrom(instance),
				bucket,
				persistWorkspace: 'source',
				automaticThumbnails: enabled,
			}).retire(session);
			expect(order).toEqual(enabled ? ['save', 'thumbnail', 'destroy'] : ['save', 'destroy']);
		},
	);

	it.each([
		{ source: 'subtree', version: 'none', expected: '/srv/work/python' },
		{ source: 'subtree', version: 'pinned', expected: '/srv/work/old' },
		{ source: 'subtree', version: 'legacy', expected: '/srv/work/python' },
		{ source: 'subtree', version: 'missing', expected: '/srv/work/python' },
		{ source: 'missing', version: 'none', expected: '/srv/work' },
	] as const)(
		'captures thumbnails from the $source workspace dir ($version version)',
		async ({ source, version, expected }) => {
			const { instance } = makeFakeSandbox();
			vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockResolvedValue(true);
			const capture = vi.spyOn(thumbnailCapture, 'captureThumbnail').mockResolvedValue();
			const getSource = vi.spyOn(notebooks, 'getNotebookSource');
			if (source === 'subtree') {
				getSource.mockResolvedValue({
					schema_version: 1,
					type: 'git',
					provider: 'github',
					repo: 'org/repo',
					branch: 'main',
					root_path: 'python',
					entry_notebook: 'nb.py',
					sync_mode: 'pull',
					current_version_id: null,
					commit: null,
					last_synced_at: null,
				} as never);
			} else {
				getSource.mockRejectedValue(new NotFoundError('gone'));
			}
			const sourceVersionId = createVersionId();
			if (version === 'pinned' || version === 'legacy') {
				await bucket.put(
					paths.project(projectId).notebook(notebookId).version(sourceVersionId).meta,
					JSON.stringify(
						makeVersion({
							version_id: sourceVersionId,
							notebook_id: notebookId,
							commit: 'abc123',
							...(version === 'pinned'
								? {
										git_source: {
											provider: 'github',
											repo: 'org/repo',
											branch: 'main',
											root_path: 'old',
											entry_notebook: 'nb.py',
											commit: 'abc123',
										},
									}
								: {}),
						}),
					),
				);
			}
			const session = await persistentSession(
				version === 'none' ? {} : { source_version_id: sourceVersionId },
			);
			await sessions.beginTerminating(projectId, session.session_id);
			await new SessionRetirer({
				sessions,
				notebooks,
				compute: fakeComputeFrom(instance),
				bucket,
				persistWorkspace: 'source',
				workdir: '/srv/work',
			}).retire(session);
			expect(capture.mock.calls[0]?.[5]).toBe(expected);
		},
	);

	it.each(['ineligible', 'failed'] as const)(
		'skips thumbnails after an %s save',
		async (result) => {
			const { instance } = makeFakeSandbox();
			const order: string[] = [];
			vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockImplementation(async () => {
				order.push('save');
				if (result === 'failed') throw new Error('save failed');
				return false;
			});
			vi.spyOn(thumbnailCapture, 'captureThumbnail').mockImplementation(async () => {
				order.push('thumbnail');
			});
			vi.spyOn(instance, 'destroy').mockImplementation(async () => {
				order.push('destroy');
			});
			const session = await persistentSession();
			await sessions.beginTerminating(projectId, session.session_id);
			await retirer(fakeComputeFrom(instance)).retire(session);
			expect(order).toEqual(['save', 'destroy']);
		},
	);

	it('marks a destroyed editor as reclaimed before releasing its claim', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await sessions.beginTerminating(projectId, session.session_id);
		const releaseEditor = sessions.releaseEditorFor.bind(sessions);
		vi.spyOn(sessions, 'releaseEditorFor').mockImplementation(async (retired) => {
			expect(await sessions.getSession(projectId, session.session_id)).toMatchObject({
				status: 'terminated',
				sandbox_reclaimed_at: expect.any(String),
			});
			return releaseEditor(retired);
		});

		await retirer(fakeComputeFrom(instance)).retire(session);

		expect(calls.destroy).toBe(1);
		expect(sessions.releaseEditorFor).toHaveBeenCalledOnce();
		expect(await sessions.listEditorsBlockingSourceUpdate(projectId, notebookId)).toEqual([]);
	});

	it('does not mark the sandbox reclaimed while another stop owns its teardown', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await sessions.beginTerminating(projectId, session.session_id);

		await retirer(fakeComputeFrom(instance)).retire(session, { teardown: false });

		expect(calls.destroy).toBe(0);
		expect(
			(await sessions.getSession(projectId, session.session_id)).sandbox_reclaimed_at,
		).toBeUndefined();
		expect(await sessions.listEditorsBlockingSourceUpdate(projectId, notebookId)).toHaveLength(1);
		expect(await sessions.getEditorClaim(projectId, notebookId)).toMatchObject({
			session_id: session.session_id,
		});
	});

	it('retains the editor claim until a failed destroy is later confirmed', async () => {
		const { instance } = makeFakeSandbox();
		let destroyFails = true;
		instance.destroy = async () => {
			if (destroyFails) throw new Error('compute unavailable');
		};
		const session = await persistentSession();
		await sessions.beginTerminating(projectId, session.session_id);
		const service = retirer({ create: () => instance, proxy: async () => null });

		await service.retire(session);

		const terminated = await sessions.getSession(projectId, session.session_id);
		expect(terminated.status).toBe('terminated');
		expect(terminated.sandbox_reclaimed_at).toBeUndefined();
		expect(await sessions.getEditorClaim(projectId, notebookId)).toMatchObject({
			session_id: session.session_id,
		});

		destroyFails = false;
		expect(await service.reclaim(terminated, false)).toBe(true);
		expect(await sessions.getEditorClaim(projectId, notebookId)).toMatchObject({
			session_id: null,
		});
	});

	it('rereads stale terminal input and refuses to reclaim a running session', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		expect(
			await retirer(fakeComputeFrom(instance)).reclaim({ ...session, status: 'expired' }, true),
		).toBe(false);
		expect(calls.destroy).toBe(0);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.session_id).toBe(
			session.session_id,
		);
	});

	it('waits for a fresh Stop even if the stale reaper expires its record', async () => {
		vi.useFakeTimers();
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession({
			started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
		});
		await sessions.beginTerminating(projectId, session.session_id);
		vi.setSystemTime(Date.now() + 6 * 60_000);
		await sessions.expireStale();
		expect(await retirer(fakeComputeFrom(instance)).reclaim(session)).toBe(false);
		expect(calls.destroy).toBe(0);
		vi.setSystemTime(Date.now() + 9 * 60_000);
		expect(await retirer(fakeComputeFrom(instance)).reclaim(session)).toBe(true);
	});

	it('does not save an expired sandbox over a newer persistent editor', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await expiredEditor();
		await sessions.createSession({
			project_id: projectId,
			notebook_id: notebookId,
			user_id: ACTOR,
		});
		expect(await retirer(fakeComputeFrom(instance)).reclaim(session, true)).toBe(true);
		expect(calls.destroy).toBe(1);
		expect(notebooks.commitSession).not.toHaveBeenCalled();
	});

	it.each(['failed', 'expired'] as const)(
		'never captures an incomplete %s provision',
		async (status) => {
			const { instance, calls } = makeFakeSandbox();
			const connectExisting = vi.fn(() => instance);
			const session = await persistentSession({
				status,
				started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
			});
			expect(
				await retirer({ ...fakeComputeFrom(instance), connectExisting }).reclaim(session, true),
			).toBe(true);
			expect(connectExisting).not.toHaveBeenCalled();
			expect(notebooks.commitSession).not.toHaveBeenCalled();
			expect(calls.destroy).toBe(1);
		},
	);

	it('never allocates compute when capturing a missing sandbox', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession({
			status: 'expired',
			sandbox_url: 'https://kernel.example',
			started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
		});
		const connectExisting = vi.fn(() => {
			throw new NotFoundError('Sandbox missing');
		});
		const create = vi.fn(() => instance);
		expect(
			await retirer({ create, connectExisting, proxy: async () => null }).reclaim(session),
		).toBe(true);
		expect(connectExisting).toHaveBeenCalledOnce();
		expect(calls.exec).toEqual([]);
		expect(calls.destroy).toBe(1);
		expect(notebooks.commitSession).not.toHaveBeenCalled();
		expect(
			(await sessions.getSession(projectId, session.session_id)).sandbox_reclaimed_at,
		).toBeDefined();
	});

	it('requires strict attach for saving but permits explicit discard without it', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession({
			status: 'expired',
			sandbox_url: 'https://kernel.example',
			started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
		});
		const service = retirer({ create: () => instance, proxy: async () => null });
		expect(await service.reclaim(session)).toBe(false);
		expect(calls.destroy).toBe(0);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.session_id).toBe(
			session.session_id,
		);
		expect(await service.reclaim(session, false)).toBe(true);
		expect(calls.destroy).toBe(1);
	});

	it.each(['record', 'siblings'] as const)(
		'does not reclaim when the %s read fails',
		async (read) => {
			const session = await expiredEditor();
			const { instance, calls } = makeFakeSandbox();
			const provider = fakeComputeFrom(instance);
			const connect = vi.spyOn(provider, 'connectExisting');
			if (read === 'record')
				vi.spyOn(sessions, 'getSession').mockRejectedValueOnce(new Error('storage unavailable'));
			else
				vi.spyOn(sessions, 'listByProject').mockRejectedValueOnce(new Error('storage unavailable'));
			await expect(retirer(provider).reclaim(session)).rejects.toThrow('storage unavailable');
			expect(connect).not.toHaveBeenCalled();
			expect(calls.destroy).toBe(0);
			expect((await sessions.getEditorClaim(projectId, notebookId))?.session_id).toBe(
				session.session_id,
			);
			expect(
				(await sessions.getSession(projectId, session.session_id)).sandbox_reclaimed_at,
			).toBeUndefined();
		},
	);

	it('retries a failed reclaimed stamp after confirmed destruction', async () => {
		const session = await expiredEditor();
		const { instance, calls } = makeFakeSandbox();
		vi.spyOn(sessions, 'markSandboxReclaimed').mockRejectedValueOnce(
			new Error('write unavailable'),
		);
		const service = retirer(fakeComputeFrom(instance));
		expect(await service.reclaim(session, false)).toBe(true);
		expect(
			(await sessions.getSession(projectId, session.session_id)).sandbox_reclaimed_at,
		).toBeUndefined();
		expect((await sessions.getEditorClaim(projectId, notebookId))?.session_id).toBeNull();
		expect(await service.reclaim(session, false)).toBe(true);
		expect(
			(await sessions.getSession(projectId, session.session_id)).sandbox_reclaimed_at,
		).toBeDefined();
		expect(calls.destroy).toBe(2);
	});

	it('retries a failed claim release without destroying an already reclaimed sandbox again', async () => {
		const session = await expiredEditor();
		const { instance, calls } = makeFakeSandbox();
		const put = bucket.put.bind(bucket);
		let failRelease = true;
		vi.spyOn(bucket, 'put').mockImplementation((key, body, options) => {
			if (failRelease && key === paths.editorClaim(projectId, notebookId)) {
				failRelease = false;
				throw new Error('claim storage unavailable');
			}
			return put(key, body, options);
		});
		const service = retirer(fakeComputeFrom(instance));
		expect(await service.reclaim(session, false)).toBe(true);
		expect(
			(await sessions.getSession(projectId, session.session_id)).sandbox_reclaimed_at,
		).toBeDefined();
		expect((await sessions.getEditorClaim(projectId, notebookId))?.session_id).toBe(
			session.session_id,
		);
		expect(await service.reclaim(session, false)).toBe(true);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.session_id).toBeNull();
		expect(calls.destroy).toBe(1);
	});

	it('does not release a replacement claim when an older destruction completes late', async () => {
		const session = await expiredEditor();
		const { instance } = makeFakeSandbox();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		vi.spyOn(instance, 'destroy').mockImplementation(async () => {
			entered.resolve();
			await finish.promise;
		});
		const reclaim = retirer(fakeComputeFrom(instance)).reclaim(session, false);
		await entered.promise;
		let replacement: Session;
		try {
			await sessions.markSandboxReclaimed(projectId, session.session_id, new Date().toISOString());
			replacement = await sessions.createSession({
				project_id: projectId,
				notebook_id: notebookId,
				user_id: ACTOR,
			});
			expect(
				(await sessions.claimEditor(projectId, notebookId, replacement.session_id, 'exclusive'))
					.claimed,
			).toBe(true);
		} finally {
			finish.resolve();
		}
		expect(await reclaim).toBe(true);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.session_id).toBe(
			replacement.session_id,
		);
	});

	it.each(['expired', 'terminating'] as const)(
		'honors the exact reclaim grace boundary for %s',
		async (status) => {
			const now = Date.now();
			const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
			const { instance, calls } = makeFakeSandbox();
			const session = await expiredEditor({
				status,
				sandbox_url: undefined,
				started_at: new Date(now).toISOString(),
				...(status === 'terminating' ? { terminating_at: new Date(now).toISOString() } : {}),
			});
			const service = retirer(fakeComputeFrom(instance));
			clock.mockReturnValue(now + 15 * 60_000 - 1);
			expect(await service.reclaim(session, false)).toBe(false);
			expect(calls.destroy).toBe(0);
			clock.mockReturnValue(now + 15 * 60_000);
			expect(await service.reclaim(session, false)).toBe(true);
			expect(calls.destroy).toBe(1);
		},
	);

	it('skips save at the authorization boundary even during provision grace', async () => {
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const session = await expiredEditor({
			started_at: new Date(now).toISOString(),
			authorization_expires_at: new Date(now).toISOString(),
		});
		const { instance, calls } = makeFakeSandbox();
		const provider = fakeComputeFrom(instance);
		const connect = vi.spyOn(provider, 'connectExisting');
		expect(await retirer(provider).reclaim(session, true)).toBe(true);
		expect(connect).not.toHaveBeenCalled();
		expect(notebooks.commitSession).not.toHaveBeenCalled();
		expect(calls.destroy).toBe(1);
	});

	it('destroys after a capture failure without publishing a saved-artifact snapshot', async () => {
		const session = await expiredEditor();
		const { instance, calls } = makeFakeSandbox();
		const provider = { ...snapshotProvider(instance), connectExisting: () => instance };
		const capture = vi.spyOn(provider, 'captureSnapshot');
		vi.spyOn(notebooks, 'commitSession').mockRejectedValueOnce(new Error('commit unavailable'));
		expect(await retirer(provider).reclaim(session)).toBe(true);
		expect(notebooks.commitSession).toHaveBeenCalledOnce();
		expect(capture).not.toHaveBeenCalled();
		expect(calls.destroy).toBe(1);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.session_id).toBeNull();
	});

	it('can destroy immediately without capturing after an authorization deadline', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await sessions.beginTerminating(projectId, session.session_id);

		await retirer({ create: () => instance, proxy: async () => null }).retire(session, {
			captureBeforeDestroy: false,
		});

		expect(calls.destroy).toBe(1);
		expect(notebooks.getNotebook).not.toHaveBeenCalled();
		expect(notebooks.commitSession).not.toHaveBeenCalled();
		expect(await sessions.getSession(projectId, session.session_id)).toMatchObject({
			status: 'terminated',
			sandbox_reclaimed_at: expect.any(String),
		});
		expect(await sessions.getEditorClaim(projectId, notebookId)).toMatchObject({
			session_id: null,
		});
	});

	it('stops VS Code and OpenCode before destroying their shared sandbox', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession({
			surfaces: {
				vscode: { status: 'ready', port: 8443, url: 'https://vscode.example/' },
				opencode: { status: 'ready', port: 4096, url: 'https://opencode.example/' },
			},
		});
		await sessions.beginTerminating(projectId, session.session_id);

		await retirer(fakeComputeFrom(instance)).retire(session);

		const stopCommands = calls.exec.filter((command) => command.includes('/surface.pid'));
		expect(stopCommands.some((command) => command.includes('/vscode/surface.pid'))).toBe(true);
		expect(stopCommands.some((command) => command.includes('/opencode/surface.pid'))).toBe(true);
		expect(calls.destroy).toBe(1);
	});

	it('waits for every secondary stop before destroying after a stop failure', async () => {
		vi.useFakeTimers();
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession({
			surfaces: {
				vscode: { status: 'ready', port: 8443, url: 'https://vscode.example/' },
				opencode: { status: 'ready', port: 4096, url: 'https://opencode.example/' },
			},
		});
		await sessions.beginTerminating(projectId, session.session_id);
		let stopped = false;
		instance.exec = async (command) => {
			if (command.includes('/vscode/surface.pid')) {
				return execResult(false, '', 'stop failed');
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
			stopped = true;
			return execResult(true, '', '');
		};
		const capture = vi.spyOn(SandboxProvisioner.prototype, 'captureSession');
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const retiring = retirer(fakeComputeFrom(instance)).retire(session);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.destroy).toBe(0);
		expect(stopped).toBe(false);
		await vi.advanceTimersByTimeAsync(100);
		await retiring;

		expect(stopped).toBe(true);
		expect(calls.destroy).toBe(1);
		expect(capture).not.toHaveBeenCalled();
	});

	it.each(['capture', 'read'] as const)(
		'does not snapshot or advance the restore pointer when %s fails',
		async (failure) => {
			const { instance, calls } = makeFakeSandbox();
			const compute = snapshotProvider(instance);
			const captureSnapshot = vi.spyOn(compute, 'captureSnapshot');
			const deleteSnapshot = vi.spyOn(compute, 'deleteSnapshot');
			await notebooks.setFsSnapshot(projectId, notebookId, {
				snapshot_id: 'known-good',
				captured_at: new Date().toISOString(),
			});
			if (failure === 'read') {
				instance.readFileBounded = async () => readFileFailure('BACKEND_ERROR');
			} else {
				vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockRejectedValue(
					new Error('bucket unavailable'),
				);
			}
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const session = await persistentSession();
			await sessions.beginTerminating(projectId, session.session_id);

			await retirer(compute).retire(session);

			expect(captureSnapshot).not.toHaveBeenCalled();
			expect(deleteSnapshot).not.toHaveBeenCalled();
			expect(await notebooks.getFsSnapshot(projectId, notebookId)).toMatchObject({
				snapshot_id: 'known-good',
			});
			expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
			expect(calls.destroy).toBe(1);
		},
	);

	it('snapshots and GCs the previous snapshot after a successful capture', async () => {
		const { instance } = makeFakeSandbox();
		const compute = snapshotProvider(instance);
		const deleteSnapshot = vi.spyOn(compute, 'deleteSnapshot');
		await notebooks.setFsSnapshot(projectId, notebookId, {
			snapshot_id: 'previous',
			captured_at: new Date().toISOString(),
		});
		vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockResolvedValue(true);
		const session = await persistentSession();
		await sessions.beginTerminating(projectId, session.session_id);

		await retirer(compute).retire(session);

		expect(await notebooks.getFsSnapshot(projectId, notebookId)).toMatchObject({
			snapshot_id: 'snapshot-after-takeover',
		});
		expect(deleteSnapshot).toHaveBeenCalledWith('previous');
	});

	it('does not snapshot when the capture reports nothing persisted', async () => {
		const { instance } = makeFakeSandbox();
		const compute = snapshotProvider(instance);
		const captureSnapshot = vi.spyOn(compute, 'captureSnapshot');
		vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockResolvedValue(false);
		const session = await persistentSession();
		await sessions.beginTerminating(projectId, session.session_id);

		await retirer(compute).retire(session);

		expect(captureSnapshot).not.toHaveBeenCalled();
	});

	it('fences a probing secondary surface before capturing the workspace', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		let enteredProbe!: () => void;
		const probing = new Promise<void>((resolve) => {
			enteredProbe = resolve;
		});
		let finishProbe!: () => void;
		const probeGate = new Promise<void>((resolve) => {
			finishProbe = resolve;
		});
		const vscode = vscodeSurface();
		const manager = new SurfaceManager(
			fakeComputeFrom(instance),
			sessions,
			new SurfaceRegistry([
				marimoSurface,
				{
					...vscode,
					probe: async () => {
						enteredProbe();
						await probeGate;
						return { available: true };
					},
				},
			]),
		);
		const begun = await manager.begin(session, 'vscode', {
			user: { id: ACTOR, email: 'owner@example.com' },
			workspaceDir: '/workspace',
			exposure: 'subdomain',
			hostname: 'sandbox.example',
		});
		await probing;
		await sessions.beginTerminating(projectId, session.session_id);
		vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockImplementation(async () => {
			expect(
				(await sessions.getSession(projectId, session.session_id)).surfaces?.vscode?.status,
			).toBe('stopping');
			return false;
		});

		await retirer(fakeComputeFrom(instance)).retire(session);
		finishProbe();

		await expect(begun.completion).rejects.toThrow('cancelled');
		expect(calls.startProcess).toHaveLength(0);
		expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
	});

	it('cancels a stale launcher before capturing the workspace', async () => {
		const { instance } = makeFakeSandbox();
		const session = await persistentSession();
		let markerCreated = false;
		const originalExec = instance.exec.bind(instance);
		instance.exec = async (cmd, options) => {
			const result = await originalExec(cmd, options);
			if (cmd.includes('touch') && cmd.includes('/cancel-')) markerCreated = true;
			return result;
		};
		let enteredStart!: () => void;
		const starting = new Promise<void>((resolve) => {
			enteredStart = resolve;
		});
		let releaseStart!: () => void;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		let launchCommandRan = false;
		const originalStartProcess = instance.startProcess.bind(instance);
		instance.startProcess = async (cmd, options) => {
			enteredStart();
			await startGate;
			if (!markerCreated) launchCommandRan = true;
			return originalStartProcess(cmd, options);
		};
		const manager = new SurfaceManager(
			fakeComputeFrom(instance),
			sessions,
			new SurfaceRegistry([marimoSurface, vscodeSurface()]),
		);
		const begun = await manager.begin(session, 'vscode', {
			user: { id: ACTOR, email: 'owner@example.com' },
			workspaceDir: '/workspace',
			exposure: 'subdomain',
			hostname: 'sandbox.example',
		});
		await starting;
		await sessions.beginTerminating(projectId, session.session_id);
		let enteredCapture!: () => void;
		const capturing = new Promise<void>((resolve) => {
			enteredCapture = resolve;
		});
		let releaseCapture!: () => void;
		const captureGate = new Promise<void>((resolve) => {
			releaseCapture = resolve;
		});
		vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockImplementation(async () => {
			enteredCapture();
			await captureGate;
			return false;
		});

		const retirement = retirer(fakeComputeFrom(instance)).retire(session);
		await capturing;
		expect(markerCreated).toBe(true);
		expect(launchCommandRan).toBe(false);

		releaseStart();
		await expect(begun.completion).rejects.toThrow('cancelled');
		expect(launchCommandRan).toBe(false);
		releaseCapture();
		await retirement;
	});

	it('captures sessions without secondary surfaces without rereading their stop fences', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await sessions.beginTerminating(projectId, session.session_id);
		const capture = vi
			.spyOn(SandboxProvisioner.prototype, 'captureSession')
			.mockResolvedValue(false);
		const getSession = vi
			.spyOn(sessions, 'getSession')
			.mockResolvedValueOnce(session)
			.mockRejectedValueOnce(new Error('Storage unavailable'));

		await retirer(fakeComputeFrom(instance)).retire(session);

		expect(getSession).toHaveBeenCalledTimes(1);
		expect(capture).toHaveBeenCalledOnce();
		expect(calls.destroy).toBe(1);
	});

	it.each(['initial read', 'fence write', 'fenced read'] as const)(
		'retains unsaved state for retry when the secondary surface %s fails',
		async (failure) => {
			const { instance, calls } = makeFakeSandbox();
			const session = await persistentSession({
				surfaces: {
					vscode: {
						status: 'starting',
						attempt_id: 'start-attempt',
						attempt_started_at: new Date().toISOString(),
					},
				},
			});
			await sessions.beginTerminating(projectId, session.session_id);
			const error = new Error('Storage unavailable');
			if (failure === 'fence write') {
				vi.spyOn(sessions, 'beginSurfaceStop').mockRejectedValueOnce(error);
			} else {
				const read = vi.spyOn(sessions, 'getSession');
				if (failure === 'fenced read') read.mockResolvedValueOnce(session);
				read.mockRejectedValueOnce(error);
			}
			const capture = vi.spyOn(SandboxProvisioner.prototype, 'captureSession');

			await expect(retirer(fakeComputeFrom(instance)).retire(session)).rejects.toThrow(error);

			expect(capture).not.toHaveBeenCalled();
			expect(calls.destroy).toBe(0);
			expect(await sessions.getSession(projectId, session.session_id)).toMatchObject({
				status: 'terminating',
			});
			expect(await sessions.ownsEditorClaim(session)).toBe(true);
		},
	);

	it('does not capture when a starting surface cannot be cancelled', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession({
			surfaces: {
				vscode: {
					status: 'starting',
					attempt_id: 'start-attempt',
					attempt_started_at: new Date().toISOString(),
				},
			},
		});
		await sessions.beginTerminating(projectId, session.session_id);
		instance.exec = async () => ({
			success: false,
			stdout: '',
			stderr: 'sandbox unavailable',
			error: { code: 'BACKEND_ERROR' },
		});
		const capture = vi.spyOn(SandboxProvisioner.prototype, 'captureSession');

		await expect(retirer(fakeComputeFrom(instance)).retire(session)).resolves.toBeUndefined();

		expect(capture).not.toHaveBeenCalled();
		expect(calls.destroy).toBe(1);
		expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
	});

	it('captures an owner-scoped filesystem snapshot during takeover', async () => {
		const { instance, calls } = makeFakeSandbox();
		const compute = snapshotProvider(instance);
		const session = await persistentSession();
		const nextOwner = uid('user_01HXY00000000000000000001');

		await retirer(compute).retireForTakeover(session, nextOwner);

		const snapshot = await notebooks.getFsSnapshot(projectId, notebookId);
		expect(snapshot).toMatchObject({
			snapshot_id: 'snapshot-after-takeover',
			owner_user_id: ACTOR,
		});
		expect(
			await resolveRestoreSnapshot(compute, notebooks, projectId, notebookId, {
				sharing: 'exclusive',
				userId: nextOwner,
			}),
		).toBeUndefined();
		expect(
			await resolveRestoreSnapshot(compute, notebooks, projectId, notebookId, {
				sharing: 'exclusive',
				userId: ACTOR,
			}),
		).toEqual(snapshot ?? undefined);
		expect(calls.destroy).toBe(1);
		expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
	});

	it('skips the filesystem snapshot when takeover persistence is ineligible', async () => {
		const { instance, calls } = makeFakeSandbox();
		const compute = snapshotProvider(instance);
		const captureSnapshot = vi.spyOn(compute, 'captureSnapshot');
		const session = await persistentSession();
		vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockResolvedValue(false);

		await retirer(compute).retireForTakeover(session, uid('user_01HXY00000000000000000001'));

		expect(captureSnapshot).not.toHaveBeenCalled();
		expect(calls.destroy).toBe(1);
	});

	it('does not continue takeover teardown after losing the terminating transition', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		vi.spyOn(sessions, 'beginTerminating').mockResolvedValue({
			session: { ...session, status: 'terminating' },
			transitioned: false,
		});

		await expect(
			retirer({ create: () => instance, proxy: async () => null }).retireForTakeover(
				session,
				uid('user_01HXY00000000000000000001'),
			),
		).rejects.toThrow('already started terminating');
		expect(notebooks.commitSession).not.toHaveBeenCalled();
		expect(calls.destroy).toBe(0);
	});

	it('still destroys the takeover sandbox when filesystem snapshot capture fails', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		await retirer(snapshotProvider(instance, { failCapture: true })).retireForTakeover(
			session,
			uid('user_01HXY00000000000000000001'),
		);

		expect(calls.destroy).toBe(1);
		expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
	});

	it.each(['capture', 'read'] as const)(
		'keeps a takeover draining when its final %s fails',
		async (failure) => {
			const { instance, calls } = makeFakeSandbox();
			const session = await persistentSession();
			await reserveTakeover(session, 'capture-retry');
			const capture = vi.spyOn(SandboxProvisioner.prototype, 'captureSession');
			const read = vi.spyOn(instance, 'readFileBounded');
			if (failure === 'read') {
				read.mockResolvedValue(readFileFailure('READ_FAILED'));
			} else {
				capture.mockRejectedValueOnce(new Error('final save failed'));
			}
			const service = retirer({ create: () => instance, proxy: async () => null });

			await expect(
				service.retireForTakeover(session, uid('user_01HXY00000000000000000001')),
			).rejects.toThrow(
				failure === 'read' ? 'Could not read notebook.py: READ_FAILED' : 'final save failed',
			);
			expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminating');
			expect(calls.destroy).toBe(0);

			await sessions.setTakeoverPhase(projectId, notebookId, 'capture-retry', 'draining');
			if (failure === 'read') read.mockRestore();
			else capture.mockResolvedValueOnce(true);
			expect(await service.completeTakeoverDrain(session, 'capture-retry', 'lease-retry')).toBe(
				true,
			);
			expect(calls.destroy).toBe(1);
			expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
		},
	);

	it('resumes after destruction when the terminal status write fails', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await reserveTakeover(session, 'terminal-retry');
		const capture = vi.spyOn(SandboxProvisioner.prototype, 'captureSession');
		vi.spyOn(sessions, 'markTerminated').mockRejectedValueOnce(
			new Error('session record unavailable'),
		);
		const service = retirer({ create: () => instance, proxy: async () => null });

		await expect(
			service.retireForTakeover(session, uid('user_01HXY00000000000000000001')),
		).rejects.toThrow('session record unavailable');
		const draining = await sessions.getSession(projectId, session.session_id);
		expect(draining).toMatchObject({
			status: 'terminating',
			takeover_capture_completed_at: expect.any(String),
			sandbox_reclaimed_at: expect.any(String),
		});

		await sessions.setTakeoverPhase(projectId, notebookId, 'terminal-retry', 'draining');
		expect(await service.completeTakeoverDrain(draining, 'terminal-retry', 'lease-retry')).toBe(
			true,
		);

		expect(capture).toHaveBeenCalledTimes(1);
		expect(calls.destroy).toBe(1);
		expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
	});

	it('repeats capture safely when the capture-complete marker write is interrupted', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await reserveTakeover(session, 'capture-marker-retry');
		await sessions.setTakeoverPhase(projectId, notebookId, 'capture-marker-retry', 'draining');
		await sessions.beginTerminating(projectId, session.session_id, {
			reason: 'takeover',
			by: uid('user_01HXY00000000000000000001'),
		});
		const capture = vi
			.spyOn(SandboxProvisioner.prototype, 'captureSession')
			.mockResolvedValue(true);
		vi.spyOn(sessions, 'markTakeoverCaptureCompleted').mockRejectedValueOnce(
			new Error('capture marker unavailable'),
		);
		const service = retirer({ create: () => instance, proxy: async () => null });

		await expect(
			service.completeTakeoverDrain(session, 'capture-marker-retry', 'lease-first'),
		).rejects.toThrow('capture marker unavailable');
		expect(calls.destroy).toBe(0);
		await expect(
			service.completeTakeoverDrain(session, 'capture-marker-retry', 'lease-second'),
		).resolves.toBe(true);

		expect(capture).toHaveBeenCalledTimes(2);
		expect(calls.destroy).toBe(1);
	});

	it('repeats destroy safely when the reclaimed marker write is interrupted', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await reserveTakeover(session, 'destroy-marker-retry');
		await sessions.setTakeoverPhase(projectId, notebookId, 'destroy-marker-retry', 'draining');
		await sessions.beginTerminating(projectId, session.session_id, {
			reason: 'takeover',
			by: uid('user_01HXY00000000000000000001'),
		});
		const capture = vi
			.spyOn(SandboxProvisioner.prototype, 'captureSession')
			.mockResolvedValue(true);
		vi.spyOn(sessions, 'markSandboxReclaimed').mockRejectedValueOnce(
			new Error('reclaimed marker unavailable'),
		);
		const service = retirer({ create: () => instance, proxy: async () => null });

		await expect(
			service.completeTakeoverDrain(session, 'destroy-marker-retry', 'lease-first'),
		).rejects.toThrow('reclaimed marker unavailable');
		expect(calls.destroy).toBe(1);
		await expect(
			service.completeTakeoverDrain(session, 'destroy-marker-retry', 'lease-second'),
		).resolves.toBe(true);

		expect(capture).toHaveBeenCalledTimes(1);
		expect(calls.destroy).toBe(2);
	});

	it('serializes concurrent retries of a draining takeover', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await reserveTakeover(session, 'concurrent-retry');
		await sessions.setTakeoverPhase(projectId, notebookId, 'concurrent-retry', 'draining');
		await sessions.beginTerminating(projectId, session.session_id, {
			reason: 'takeover',
			by: uid('user_01HXY00000000000000000001'),
		});
		let releaseCapture!: () => void;
		let captureStarted!: () => void;
		const captureGate = new Promise<void>((resolve) => {
			releaseCapture = resolve;
		});
		const started = new Promise<void>((resolve) => {
			captureStarted = resolve;
		});
		const capture = vi
			.spyOn(SandboxProvisioner.prototype, 'captureSession')
			.mockImplementation(async () => {
				captureStarted();
				await captureGate;
				return true;
			});
		const service = retirer({ create: () => instance, proxy: async () => null });

		const first = service.completeTakeoverDrain(session, 'concurrent-retry', 'lease-first');
		await started;
		await expect(
			service.completeTakeoverDrain(session, 'concurrent-retry', 'lease-second'),
		).resolves.toBe(false);
		releaseCapture();
		await expect(first).resolves.toBe(true);

		expect(capture).toHaveBeenCalledTimes(1);
		expect(calls.destroy).toBe(1);
	});

	it('renews the drain lease throughout a capture lasting longer than its deadline', async () => {
		vi.useFakeTimers();
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await reserveTakeover(session, 'long-capture');
		await sessions.setTakeoverPhase(projectId, notebookId, 'long-capture', 'draining');
		await sessions.beginTerminating(projectId, session.session_id, {
			reason: 'takeover',
			by: uid('user_01HXY00000000000000000001'),
		});
		let releaseCapture!: () => void;
		let captureStarted!: () => void;
		const captureGate = new Promise<void>((resolve) => {
			releaseCapture = resolve;
		});
		const started = new Promise<void>((resolve) => {
			captureStarted = resolve;
		});
		const capture = vi
			.spyOn(SandboxProvisioner.prototype, 'captureSession')
			.mockImplementation(async () => {
				captureStarted();
				await captureGate;
				return true;
			});
		const renew = vi.spyOn(sessions, 'renewTakeoverDrainLease');
		const service = retirer({ create: () => instance, proxy: async () => null });

		const first = service.completeTakeoverDrain(session, 'long-capture', 'lease-first');
		await started;
		await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

		await expect(
			service.completeTakeoverDrain(session, 'long-capture', 'lease-second'),
		).resolves.toBe(false);
		releaseCapture();
		await expect(first).resolves.toBe(true);

		expect(renew).toHaveBeenCalled();
		expect(capture).toHaveBeenCalledTimes(1);
		expect(calls.destroy).toBe(1);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.transfer?.phase).toBe('ready');
	});

	it('renews the drain lease throughout sandbox destruction', async () => {
		vi.useFakeTimers();
		const { instance, calls } = makeFakeSandbox();
		const originalDestroy = instance.destroy.bind(instance);
		let releaseDestroy!: () => void;
		let destroyStarted!: () => void;
		const destroyGate = new Promise<void>((resolve) => {
			releaseDestroy = resolve;
		});
		const started = new Promise<void>((resolve) => {
			destroyStarted = resolve;
		});
		instance.destroy = async () => {
			destroyStarted();
			await destroyGate;
			await originalDestroy();
		};
		const session = await persistentSession();
		await reserveTakeover(session, 'long-destroy');
		await sessions.setTakeoverPhase(projectId, notebookId, 'long-destroy', 'draining');
		await sessions.beginTerminating(projectId, session.session_id, {
			reason: 'takeover',
			by: uid('user_01HXY00000000000000000001'),
		});
		const service = retirer({ create: () => instance, proxy: async () => null });

		const first = service.completeTakeoverDrain(session, 'long-destroy', 'lease-first');
		await started;
		await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

		await expect(
			service.completeTakeoverDrain(session, 'long-destroy', 'lease-second'),
		).resolves.toBe(false);
		releaseDestroy();
		await expect(first).resolves.toBe(true);

		expect(notebooks.commitSession).toHaveBeenCalledTimes(1);
		expect(calls.destroy).toBe(1);
	});

	it('yields a drain that makes no progress for thirty minutes', async () => {
		vi.useFakeTimers();
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await reserveTakeover(session, 'stuck-capture');
		await sessions.setTakeoverPhase(projectId, notebookId, 'stuck-capture', 'draining');
		await sessions.beginTerminating(projectId, session.session_id, {
			reason: 'takeover',
			by: uid('user_01HXY00000000000000000001'),
		});
		let releaseCapture!: () => void;
		let captureStarted!: () => void;
		const captureGate = new Promise<void>((resolve) => {
			releaseCapture = resolve;
		});
		const started = new Promise<void>((resolve) => {
			captureStarted = resolve;
		});
		vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockImplementation(async () => {
			captureStarted();
			await captureGate;
			return true;
		});
		const service = retirer({ create: () => instance, proxy: async () => null });

		const stuck = service.completeTakeoverDrain(session, 'stuck-capture', 'lease-stuck');
		await started;
		await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
		await expect(
			sessions.acquireTakeoverDrainLease(projectId, notebookId, 'stuck-capture', 'lease-recovery'),
		).resolves.toBe(true);

		releaseCapture();
		await expect(stuck).rejects.toThrow('no longer owned');
		expect(calls.destroy).toBe(0);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.transfer).toMatchObject({
			drain_lease_id: 'lease-recovery',
		});
	});

	it('still destroys the sandbox when a secondary surface refuses to stop', async () => {
		const { instance, calls } = makeFakeSandbox({
			execResult: execResult(false, '', 'sandbox unavailable', 'BACKEND_ERROR'),
		});
		const session = await persistentSession({
			status: 'terminating',
			surfaces: {
				vscode: {
					status: 'ready',
					port: 8443,
					url: 'https://vscode.example',
					started_at: new Date().toISOString(),
				},
			},
		});
		const service = retirer(fakeComputeFrom(instance));

		await expect(service.retire(session)).resolves.toBeUndefined();

		expect(calls.destroy).toBe(1);
		expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
	});
});
