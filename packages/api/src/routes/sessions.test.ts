import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	createNotebookId,
	createProjectId,
	createServices,
	Millis,
	ProjectSecretsStore,
} from '@marimo-hub/core';
import type { NotebookId, ProjectId, Session, SessionId } from '@marimo-hub/core';
import {
	ACTOR,
	fakeComputeFrom,
	makeFakeCompute,
	makeFakeSandbox,
	uid,
} from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import type { ApiDeps } from '../context';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	expectPage,
} from '../testing';

const STRANGER = uid('user_stranger');
type ApiSession = Session & {
	can: { attach: boolean; stop: boolean };
	reused?: boolean;
};

type EditorState = {
	sharing: 'shared' | 'exclusive';
	holder: null | {
		session_id: string;
		user_id: string;
		activity: { state: 'active' | 'idle' | 'unknown' | 'starting' };
	};
	can_take_over: boolean;
};

describe('Session routes', () => {
	let bucket: MemoryBucket;
	let owner: ReturnType<typeof createTestApi>['request'];
	let stranger: ReturnType<typeof createTestApi>['request'];
	let pid: ProjectId;
	let nid: NotebookId;

	beforeEach(async () => {
		bucket = await createInitializedBucket();

		// Seed a project owned by ACTOR and a notebook inside it.
		const services = createServices(bucket);
		const project = await services.projects.createProject(
			{ name: 'Owned', description: 'd' },
			ACTOR,
		);
		pid = project.id as ProjectId;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		nid = notebook.id as NotebookId;

		// A healthy fake compute backs the owner/stranger apps so provisioning succeeds.
		owner = createTestApi({ bucket, userId: ACTOR, compute: makeFakeCompute() }).request;
		stranger = createTestApi({ bucket, userId: STRANGER, compute: makeFakeCompute() }).request;
	});

	const sessionsPath = (suffix = '') => `/projects/${pid}/notebooks/${nid}/sessions${suffix}`;
	const editorSessionPath = (suffix = '') =>
		`/projects/${pid}/notebooks/${nid}/editor-session${suffix}`;
	const sandboxConfig = (overrides: Partial<ApiDeps['sandbox']> = {}): ApiDeps['sandbox'] => ({
		bucket: { name: 'test', endpoint: '' },
		hostname: 'localhost',
		workdir: '/workspace',
		persistWorkspace: 'source',
		...overrides,
	});
	const exclusiveApi = (
		userId: ReturnType<typeof uid>,
		compute: ApiDeps['compute'] = makeFakeCompute(),
		extraDeps: Partial<ApiDeps> = {},
	) =>
		createTestApi({
			bucket,
			userId,
			compute,
			deps: {
				...extraDeps,
				policy: {
					editorSandboxSharing: 'exclusive',
					defaultRole: 'editor',
					...extraDeps.policy,
				},
			},
		}).request;

	async function startSession(): Promise<string> {
		const data = await expectOk<ApiSession>(await owner('POST', sessionsPath()));
		return data.session_id as string;
	}

	it('POST /sessions with a non-existent notebook returns 404 and does not provision', async () => {
		// Use a notebook id that was never created in this project.
		const bogusNid = createNotebookId();
		const path = `/projects/${pid}/notebooks/${bogusNid}/sessions`;
		await expectError(await owner('POST', path), 404, 'NOT_FOUND');

		// No session record should have been created.
		const all = await createServices(bucket).sessions.listSessions(bogusNid);
		expect(all).toHaveLength(0);
	});

	it('POST /sessions for an unsynced GitHub notebook returns 400 and does not provision', async () => {
		const services = createServices(bucket);
		const { meta } = await services.notebooks.synced.create(
			pid,
			{
				title: 'GitHub NB',
				description: 'd',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
			},
			ACTOR,
		);
		const path = `/projects/${pid}/notebooks/${meta.id}/sessions`;

		await expectError(await owner('POST', path), 400, 'BAD_REQUEST');
		expect(await services.sessions.listSessions(meta.id)).toHaveLength(0);
	});

	it('POST /sessions as the owner (editor) creates a running session', async () => {
		const data = await expectOk<ApiSession>(await owner('POST', sessionsPath()));
		expect(data.session_id).toMatch(/^sess-/);
		expect(data.status).toBe('running');
		expect(data.project_id).toBe(pid);
		expect(data.notebook_id).toBe(nid);
		// The response exposes who started the session (for the "started by" UI).
		expect(data.user_id).toBe(ACTOR);
		expect(data.reused).toBe(false);
		// A healthy session carries no failure reason.
		expect(data.error).toBeUndefined();
	});

	it('defaults to one shared edit sandbox across users', async () => {
		const first = await expectOk<ApiSession>(await owner('POST', sessionsPath()));
		const sharedOther = createTestApi({
			bucket,
			userId: STRANGER,
			compute: makeFakeCompute(),
			deps: { policy: { defaultRole: 'editor' } },
		}).request;
		const second = await expectOk<ApiSession>(await sharedOther('POST', sessionsPath()));
		expect(second.session_id).toBe(first.session_id);
		expect(second.reused).toBe(true);
		expect(second.editor_sandbox_sharing).toBe('shared');
		expect(second.can.attach).toBe(true);
	});

	it('uses the configured sharing mode after the previous claim is released', async () => {
		const shared = await expectOk<ApiSession>(await owner('POST', sessionsPath()));
		await expectOk(await owner('DELETE', sessionsPath(`/${shared.session_id}`)));

		const services = createServices(bucket);
		expect(await services.sessions.getEditorClaim(pid, nid)).toMatchObject({
			session_id: null,
			sharing: 'shared',
		});

		const exclusive = exclusiveApi(STRANGER);
		const state = await expectOk<EditorState>(await exclusive('GET', editorSessionPath()));
		expect(state).toMatchObject({ sharing: 'exclusive', holder: null });

		const replacement = await expectOk<ApiSession>(await exclusive('POST', sessionsPath()));
		expect(replacement.editor_sandbox_sharing).toBe('exclusive');
		expect(await services.sessions.getEditorClaim(pid, nid)).toMatchObject({
			session_id: replacement.session_id,
			sharing: 'exclusive',
		});
	});

	it('requires an explicit temporary choice when an exclusive session has another owner', async () => {
		const exclusiveOwner = exclusiveApi(ACTOR);
		const exclusiveOther = exclusiveApi(STRANGER);
		const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		await expectError(await exclusiveOther('POST', sessionsPath()), 409, 'EDIT_SESSION_OWNED');
		const temporary = await expectOk<ApiSession>(
			await exclusiveOther('POST', sessionsPath(), { edit_intent: 'temporary' }),
		);
		expect(temporary.ephemeral).toBe(true);
		expect(temporary.session_id).not.toBe(persistent.session_id);
		expect(temporary.editor_sandbox_sharing).toBe('exclusive');
	});

	it('does not restore a filesystem snapshot into a temporary editor sandbox', async () => {
		const exclusiveOwner = exclusiveApi(ACTOR);
		await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		await createServices(bucket).notebooks.setFsSnapshot(pid, nid, {
			snapshot_id: 'snap-other-editor',
			captured_at: '2026-07-01T00:00:00.000Z',
			owner_user_id: STRANGER,
		});
		const { instance } = makeFakeSandbox();
		const restored: string[] = [];
		const compute = {
			...fakeComputeFrom(instance),
			filesystemSnapshotsEnabled: true,
			createFromSnapshot(_id: string, snapshotId: string) {
				restored.push(snapshotId);
				return instance;
			},
			async captureSnapshot() {
				return { snapshotId: 'unused' };
			},
			async deleteSnapshot() {},
		};
		const exclusiveOther = exclusiveApi(STRANGER, compute);

		const data = await expectOk<ApiSession>(
			await exclusiveOther('POST', sessionsPath(), { edit_intent: 'temporary' }),
		);
		expect(data.ephemeral).toBe(true);
		expect(restored).toEqual([]);
		expect(data.compute_from_snapshot).toBeUndefined();
	});

	it('reports exclusive ownership and completes a warned takeover before replacement', async () => {
		const ownerCompute = makeFakeCompute();
		const otherCompute = makeFakeCompute();
		const exclusiveOwner = exclusiveApi(ACTOR, ownerCompute);
		const exclusiveOther = exclusiveApi(STRANGER, otherCompute, {
			policy: { maxConcurrentSessionsPerUser: 1 },
		});
		const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		const temporary = await expectOk<ApiSession>(
			await exclusiveOther('POST', sessionsPath(), { edit_intent: 'temporary' }),
		);
		const state = await expectOk<EditorState>(await exclusiveOther('GET', editorSessionPath()));
		expect(state.holder?.user_id).toBe(ACTOR);
		expect(state.can_take_over).toBe(true);
		await expectOk(
			await exclusiveOther('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-test-1',
				expected_holder_session_id: persistent.session_id,
				expected_activity: state.holder!.activity.state,
				acknowledge_disruption: true,
			}),
		);
		const replacement = await expectOk<ApiSession>(await exclusiveOther('POST', sessionsPath()));
		expect(replacement.user_id).toBe(STRANGER);
		expect(replacement.session_id).not.toBe(persistent.session_id);
		const old = await createServices(bucket).sessions.getSession(pid, persistent.session_id);
		expect(old.status).toBe('terminated');
		expect(old.ended_reason).toBe('takeover');
		expect(old.ended_by_user_id).toBe(STRANGER);
		const discarded = await createServices(bucket).sessions.getSession(pid, temporary.session_id);
		expect(discarded.status).toBe('terminated');
	});

	it('keeps the claim protected when the strict takeover save fails', async () => {
		const exclusiveOwner = exclusiveApi(ACTOR);
		const failing = makeFakeSandbox();
		failing.instance.readFile = async () => {
			throw new Error('notebook unavailable');
		};
		const exclusiveOther = exclusiveApi(STRANGER, fakeComputeFrom(failing.instance));
		const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		const state = await expectOk<EditorState>(await exclusiveOther('GET', editorSessionPath()));
		await expectError(
			await exclusiveOther('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-save-failure',
				expected_holder_session_id: persistent.session_id,
				expected_activity: state.holder!.activity.state,
				acknowledge_disruption: true,
			}),
			503,
			'SERVICE_UNAVAILABLE',
		);
		const old = await createServices(bucket).sessions.getSession(pid, persistent.session_id);
		expect(old.status).toBe('terminating');
		expect(failing.calls.destroy).toBe(0);
		expect((await createServices(bucket).sessions.getEditorClaim(pid, nid))?.transfer?.phase).toBe(
			'draining',
		);
	});

	it('keeps a failed shutdown claim protected in draining state', async () => {
		const exclusiveOwner = exclusiveApi(ACTOR);
		const failing = makeFakeSandbox();
		failing.instance.destroy = async () => {
			throw new Error('destroy unavailable');
		};
		const exclusiveOther = exclusiveApi(STRANGER, fakeComputeFrom(failing.instance));
		const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		const state = await expectOk<EditorState>(await exclusiveOther('GET', editorSessionPath()));
		await expectError(
			await exclusiveOther('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-destroy-failure',
				expected_holder_session_id: persistent.session_id,
				expected_activity: state.holder!.activity.state,
				acknowledge_disruption: true,
			}),
			503,
			'SERVICE_UNAVAILABLE',
		);
		const services = createServices(bucket);
		expect((await services.sessions.getSession(pid, persistent.session_id)).status).toBe(
			'terminating',
		);
		expect((await services.sessions.getEditorClaim(pid, nid))?.transfer?.phase).toBe('draining');
		await expectError(await exclusiveOther('POST', sessionsPath()), 409, 'TAKEOVER_IN_PROGRESS');
	});

	it('does not adopt a concurrent normal stop as takeover draining', async () => {
		const exclusiveOwner = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			deps: { policy: { editorSandboxSharing: 'exclusive', defaultRole: 'editor' } },
		});
		const takeoverSandbox = makeFakeSandbox();
		const exclusiveOther = createTestApi({
			bucket,
			userId: STRANGER,
			compute: fakeComputeFrom(takeoverSandbox.instance),
			deps: { policy: { editorSandboxSharing: 'exclusive', defaultRole: 'editor' } },
		});
		const persistent = await expectOk<ApiSession>(
			await exclusiveOwner.request('POST', sessionsPath()),
		);
		const state = await expectOk<EditorState>(
			await exclusiveOther.request('GET', editorSessionPath()),
		);
		const normalStopServices = createServices(bucket);
		vi.spyOn(exclusiveOther.deps.services.sessions, 'beginTerminating').mockImplementation(
			async () => {
				const stopped = await normalStopServices.sessions.beginTerminating(
					pid,
					persistent.session_id,
				);
				return { session: stopped.session, transitioned: false };
			},
		);

		await expectError(
			await exclusiveOther.request('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-normal-stop-race',
				expected_holder_session_id: persistent.session_id,
				expected_activity: state.holder!.activity.state,
				acknowledge_disruption: true,
			}),
			503,
			'SERVICE_UNAVAILABLE',
		);

		expect(takeoverSandbox.calls.destroy).toBe(0);
		expect((await normalStopServices.sessions.getEditorClaim(pid, nid))?.transfer).toBeUndefined();
	});

	it('requires reconfirmation whenever the displayed activity changes', async () => {
		const exclusiveOwner = exclusiveApi(ACTOR);
		const activitySandbox = makeFakeSandbox();
		const exclusiveOther = exclusiveApi(STRANGER, fakeComputeFrom(activitySandbox.instance));
		const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		await expectError(
			await exclusiveOther('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-unknown-change',
				expected_holder_session_id: persistent.session_id,
				expected_activity: 'active',
				acknowledge_disruption: true,
			}),
			409,
			'EDIT_SESSION_CHANGED',
		);
		const services = createServices(bucket);
		expect((await services.sessions.getSession(pid, persistent.session_id)).status).toBe('running');
		expect((await services.sessions.getEditorClaim(pid, nid))?.transfer).toBeUndefined();

		activitySandbox.instance.exec = async () => ({ success: true, stdout: '0', stderr: '' });
		await expectError(
			await exclusiveOther('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-idle-change',
				expected_holder_session_id: persistent.session_id,
				expected_activity: 'active',
				acknowledge_disruption: true,
			}),
			409,
			'EDIT_SESSION_CHANGED',
		);
		expect((await services.sessions.getEditorClaim(pid, nid))?.transfer).toBeUndefined();
	});

	it.each(['notebook', 'project'] as const)(
		'rejects takeover after the %s is deleted',
		async (target) => {
			const exclusiveOwner = exclusiveApi(ACTOR);
			const exclusiveOther = exclusiveApi(STRANGER);
			const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
			const services = createServices(bucket);
			if (target === 'notebook') await services.notebooks.deleteNotebook(pid, nid, ACTOR);
			else await services.projects.deleteProject(pid, ACTOR);

			await expectError(
				await exclusiveOther('POST', editorSessionPath('/takeover'), {
					takeover_id: `takeover-deleted-${target}`,
					expected_holder_session_id: persistent.session_id,
					expected_activity: 'unknown',
					acknowledge_disruption: true,
				}),
				404,
				'NOT_FOUND',
			);
		},
	);

	it('cancels takeover when membership is revoked during the activity check', async () => {
		const services = createServices(bucket);
		await services.projects.addMember(pid, { user_id: STRANGER }, 'editor', ACTOR);
		const exclusiveOwner = exclusiveApi(ACTOR);
		const activity = makeFakeSandbox();
		activity.instance.exec = async () => {
			await services.projects.removeMember(pid, STRANGER, ACTOR);
			return { success: false, stdout: '', stderr: '' };
		};
		const exclusiveOther = exclusiveApi(STRANGER, fakeComputeFrom(activity.instance), {
			policy: { defaultRole: undefined },
		});
		const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));

		await expectError(
			await exclusiveOther('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-revoked-member',
				expected_holder_session_id: persistent.session_id,
				expected_activity: 'unknown',
				acknowledge_disruption: true,
			}),
			403,
			'FORBIDDEN',
		);

		expect(activity.calls.destroy).toBe(0);
		expect((await services.sessions.getSession(pid, persistent.session_id)).status).toBe('running');
		expect((await services.sessions.getEditorClaim(pid, nid))?.transfer).toBeUndefined();
	});

	it('does not drain again when another replica reconciles the sandbox first', async () => {
		const services = createServices(bucket);
		const exclusiveOwner = exclusiveApi(ACTOR);
		const activity = makeFakeSandbox();
		const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		activity.instance.exec = async () => {
			await services.sessions.markSandboxReclaimed(
				pid,
				persistent.session_id,
				new Date().toISOString(),
			);
			await services.sessions.markTerminated(pid, persistent.session_id);
			return { success: false, stdout: '', stderr: '' };
		};
		const exclusiveOther = exclusiveApi(STRANGER, fakeComputeFrom(activity.instance));

		await expectError(
			await exclusiveOther('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-reconciled',
				expected_holder_session_id: persistent.session_id,
				expected_activity: 'unknown',
				acknowledge_disruption: true,
			}),
			503,
			'SERVICE_UNAVAILABLE',
		);

		expect(activity.calls.destroy).toBe(0);
		expect((await services.sessions.getEditorClaim(pid, nid))?.transfer).toBeUndefined();
	});

	it('injects notebook defaults into an edit session without managed AI', async () => {
		const { instance, calls } = makeFakeSandbox();
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(instance),
		}).request;

		await expectOk<any>(await request('POST', sessionsPath()));

		const config = calls.writeFiles
			.flat()
			.find((file) => file.path === '/tmp/marimohub-config/marimo/marimo.toml');
		expect(config?.content).toContain('default_width = "medium"');
		expect(config?.content).toContain('default_sql_output = "native"');
		expect(config?.content).toContain('[sharing]');
		expect(config?.content).toContain('html = false');
		expect(config?.content).toContain('wasm = false');
		expect(config?.content).toContain('molab = false');
		expect(config?.content).not.toContain('[ai]');
		expect(calls.setEnvVars).toContainEqual({
			XDG_CONFIG_HOME: '/tmp/marimohub-config',
		});
		// Cache/state redirects are fallbacks — an image defining its own wins.
		expect(calls.setEnvDefaults).toContainEqual({
			XDG_CACHE_HOME: '/tmp/marimohub-cache',
			XDG_STATE_HOME: '/tmp/marimohub-state',
		});
	});

	describe('base image resolution', () => {
		function imageApi(compute: ReturnType<typeof makeFakeCompute>) {
			return createTestApi({
				bucket,
				userId: ACTOR,
				compute,
				deps: {
					sandbox: sandboxConfig({
						images: ['img-a', 'img-b'],
					}),
				},
			}).request;
		}

		it('provisions with the default (first) image when the notebook stores no choice', async () => {
			const compute = makeFakeCompute();
			await expectOk<ApiSession>(await imageApi(compute)('POST', sessionsPath()));
			expect(compute.lastCreateOptions).toMatchObject({ image: 'img-a' });
		});

		it('provisions with the stored image when it is still listed', async () => {
			const services = createServices(bucket);
			await services.notebooks.updateNotebook(pid, nid, { base_image: 'img-b' }, ACTOR);

			const compute = makeFakeCompute();
			await expectOk<ApiSession>(await imageApi(compute)('POST', sessionsPath()));
			expect(compute.lastCreateOptions).toMatchObject({ image: 'img-b' });
		});

		it('falls back to the default image (with a warning) when the stored image fell off the list', async () => {
			const meta = await createServices(bucket).notebooks.getNotebook(pid, nid);
			await bucket.put(
				`projects/${pid}/notebooks/${nid}/meta.json`,
				JSON.stringify({ ...meta.meta, base_image: 'img-gone' }),
			);

			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const compute = makeFakeCompute();
				await expectOk<ApiSession>(await imageApi(compute)('POST', sessionsPath()));
				expect(compute.lastCreateOptions).toMatchObject({ image: 'img-a' });
				expect(warn.mock.calls.some((c) => String(c[0]).includes('img-gone'))).toBe(true);
			} finally {
				warn.mockRestore();
			}
		});

		it('passes no image when the deployment configures none', async () => {
			const compute = makeFakeCompute();
			const req = createTestApi({ bucket, userId: ACTOR, compute }).request;
			await expectOk<ApiSession>(await req('POST', sessionsPath()));
			expect(compute.lastCreateOptions?.image).toBeUndefined();
		});
	});

	it('passes default profile resources and returns the recorded profile name', async () => {
		const compute = makeFakeCompute();
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute,
			deps: {
				sandbox: sandboxConfig({
					resources: { cpu: 0.5, memoryBytes: 512 * 1024 ** 2 },
					computeProfile: 'small',
				}),
			},
		}).request;

		const data = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		expect(compute.lastCreateOptions?.resources).toEqual({
			cpu: 0.5,
			memoryBytes: 512 * 1024 ** 2,
		});
		expect(data.compute_profile).toBe('small');
		expect(data.compute_resources).toEqual({
			cpu: 0.5,
			memory_bytes: 512 * 1024 ** 2,
		});
		expect(data.compute_from_snapshot).toBeUndefined();
		const stored = await createServices(bucket).sessions.getSession(pid, data.session_id);
		expect(stored.compute_profile).toBe('small');
		expect(stored.compute_resources).toEqual({
			cpu: 0.5,
			memory_bytes: 512 * 1024 ** 2,
		});
	});

	it('provisions an editor session with the notebook compute profile override', async () => {
		await createServices(bucket).notebooks.updateNotebook(
			pid,
			nid,
			{ compute_profile: 'large' },
			ACTOR,
		);
		const compute = makeFakeCompute();
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute,
			deps: {
				sandbox: sandboxConfig({
					computeProfiles: [
						{ name: 'small', resources: { cpu: 1 } },
						{ name: 'large', resources: { cpu: 8, memoryBytes: 16 * 1024 ** 3 } },
					],
					computeProfileOverride: 'editors',
				}),
			},
		}).request;

		const data = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		expect(data.compute_profile).toBe('large');
		expect(compute.lastCreateOptions?.resources).toEqual({
			cpu: 8,
			memoryBytes: 16 * 1024 ** 3,
		});
	});

	it('retries once with Default without changing the notebook profile', async () => {
		const services = createServices(bucket);
		await services.notebooks.updateNotebook(pid, nid, { compute_profile: 'large' }, ACTOR);
		const compute = makeFakeCompute();
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute,
			deps: {
				sandbox: sandboxConfig({
					computeProfiles: [
						{ name: 'small', resources: { cpu: 1 } },
						{ name: 'large', resources: { cpu: 8 } },
					],
					computeProfileOverride: 'editors',
				}),
			},
		}).request;

		const data = await expectOk<ApiSession>(
			await request('POST', sessionsPath(), { compute_profile: 'default' }),
		);
		expect(data.compute_profile).toBe('small');
		expect(compute.lastCreateOptions?.resources).toEqual({ cpu: 1 });
		expect((await services.notebooks.getNotebook(pid, nid)).meta.compute_profile).toBe('large');
	});

	it('does not let a shared-app request bypass the notebook profile with Default', async () => {
		const services = createServices(bucket);
		await services.notebooks.updateNotebook(pid, nid, { compute_profile: 'large' }, ACTOR);
		const compute = makeFakeCompute();
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute,
			deps: {
				sandbox: sandboxConfig({
					computeProfiles: [
						{ name: 'small', resources: { cpu: 1 } },
						{ name: 'large', resources: { cpu: 8 } },
					],
					computeProfileOverride: 'editors',
				}),
			},
		}).request;

		const data = await expectOk<ApiSession>(
			await request('POST', sessionsPath(), {
				mode: 'app',
				compute_profile: 'default',
			}),
		);
		expect(data.compute_profile).toBe('large');
		expect(compute.lastCreateOptions?.resources).toEqual({ cpu: 8 });
	});

	it('reports the compute provenance restored from a filesystem snapshot', async () => {
		const services = createServices(bucket);
		await services.notebooks.updateNotebook(pid, nid, { compute_profile: 'large' }, ACTOR);
		await services.notebooks.setFsSnapshot(pid, nid, {
			snapshot_id: 'snap-old',
			captured_at: '2026-07-01T00:00:00.000Z',
			compute_profile: 'small',
			compute_resources: { cpu: 1, memory_bytes: 2 * 1024 ** 3 },
		});
		const { instance } = makeFakeSandbox();
		const restored: string[] = [];
		const compute = {
			...fakeComputeFrom(instance),
			filesystemSnapshotsEnabled: true,
			createFromSnapshot(_id: string, snapshotId: string) {
				restored.push(snapshotId);
				return instance;
			},
			async captureSnapshot() {
				return { snapshotId: 'unused' };
			},
			async deleteSnapshot() {},
		};
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute,
			deps: {
				sandbox: sandboxConfig({
					computeProfiles: [
						{ name: 'small', resources: { cpu: 2, memoryBytes: 4 * 1024 ** 3 } },
						{ name: 'large', resources: { cpu: 8 } },
					],
					computeProfileOverride: 'editors',
				}),
			},
		}).request;

		const data = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		expect(restored).toEqual(['snap-old']);
		expect(data.compute_profile).toBe('small');
		expect(data.compute_resources).toEqual({
			cpu: 1,
			memory_bytes: 2 * 1024 ** 3,
		});
		expect(data.compute_from_snapshot).toBe(true);
	});

	it('falls back when a stored compute profile is no longer configured', async () => {
		await createServices(bucket).notebooks.updateNotebook(
			pid,
			nid,
			{ compute_profile: 'removed' },
			ACTOR,
		);
		const compute = makeFakeCompute();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const request = createTestApi({
				bucket,
				userId: ACTOR,
				compute,
				deps: {
					sandbox: sandboxConfig({
						computeProfiles: [{ name: 'small', resources: { cpu: 1 } }],
						computeProfileOverride: 'editors',
					}),
				},
			}).request;

			const data = await expectOk<ApiSession>(await request('POST', sessionsPath()));
			expect(data.compute_profile).toBe('small');
			expect(compute.lastCreateOptions?.resources).toEqual({ cpu: 1 });
			expect(warn.mock.calls.some((call) => String(call[0]).includes('removed'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('forces a viewer ephemeral edit session onto the default compute profile', async () => {
		await createServices(bucket).notebooks.updateNotebook(
			pid,
			nid,
			{ compute_profile: 'large' },
			ACTOR,
		);
		const compute = makeFakeCompute();
		const request = createTestApi({
			bucket,
			userId: STRANGER,
			compute,
			deps: {
				sandbox: sandboxConfig({
					computeProfiles: [
						{ name: 'small', resources: { cpu: 1 } },
						{ name: 'large', resources: { cpu: 8 } },
					],
					computeProfileOverride: 'editors',
				}),
				policy: { defaultRole: 'viewer', viewerMode: 'ephemeral-sandbox' },
			},
		}).request;

		const data = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		expect(data.compute_profile).toBe('small');
		expect(compute.lastCreateOptions?.resources).toEqual({ cpu: 1 });
	});

	it('provisions a viewer-started shared app with the notebook compute profile', async () => {
		await createServices(bucket).notebooks.updateNotebook(
			pid,
			nid,
			{ compute_profile: 'large' },
			ACTOR,
		);
		const compute = makeFakeCompute();
		const request = createTestApi({
			bucket,
			userId: STRANGER,
			compute,
			deps: {
				sandbox: sandboxConfig({
					computeProfiles: [
						{ name: 'small', resources: { cpu: 1 } },
						{ name: 'large', resources: { cpu: 8, memoryBytes: 16 * 1024 ** 3 } },
					],
					computeProfileOverride: 'editors',
				}),
				policy: { defaultRole: 'viewer', viewerMode: 'applications' },
			},
		}).request;

		// The shared app is the notebook's app: it must run the author's profile even
		// though a viewer started it (unlike a viewer's own ephemeral edit kernel).
		const data = await expectOk<ApiSession>(await request('POST', sessionsPath(), { mode: 'app' }));
		expect(data.compute_profile).toBe('large');
		expect(compute.lastCreateOptions?.resources).toEqual({
			cpu: 8,
			memoryBytes: 16 * 1024 ** 3,
		});
	});

	it('POST /sessions stamps expires_at from the session lifetime when configured', async () => {
		const withLifetime = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			deps: {
				sandbox: {
					bucket: { name: 'test', endpoint: '' },
					hostname: 'localhost',
					workdir: '/workspace',
					persistWorkspace: 'source',
					sessionLifetime: {
						maxLifetimeMs: Millis.hours(4),
						idleTimeoutMs: Millis.minutes(30),
						snapshotIntervalMs: Millis.minutes(2),
						extensionMs: Millis.minutes(30),
						connectionAware: true,
						sweepIntervalMs: Millis.seconds(60),
					},
				},
			},
		}).request;

		const before = Date.now();
		const data = await expectOk<ApiSession>(await withLifetime('POST', sessionsPath()));
		// Internal field: not in the response, but stamped on the stored record.
		expect(data.expires_at).toBeUndefined();
		const stored = await createServices(bucket).sessions.getSession(pid, data.session_id);
		const expiresAt = Date.parse(stored.expires_at!);
		expect(expiresAt).toBeGreaterThanOrEqual(before + 4 * 60 * 60 * 1000);
		expect(expiresAt).toBeLessThan(before + 5 * 60 * 60 * 1000);
	});

	it('POST /sessions leaves expires_at unset without a session lifetime (library wiring)', async () => {
		const sid = (await startSession()) as SessionId;
		const stored = await createServices(bucket).sessions.getSession(pid, sid);
		expect(stored.expires_at).toBeUndefined();
	});

	it('POST /sessions as a non-member returns 403', async () => {
		await expectError(await stranger('POST', sessionsPath()), 403, 'FORBIDDEN');
	});

	it("a non-member super admin can start, heartbeat, and stop another user's session", async () => {
		const god = createTestApi({
			bucket,
			userId: STRANGER,
			compute: makeFakeCompute(),
			deps: { policy: { superAdmins: [STRANGER] } },
		}).request;

		const sid = await startSession(); // started by ACTOR
		const session = await expectOk<ApiSession>(await god('GET', sessionsPath(`/${sid}`)));
		expect(session.can).toEqual({ attach: true, stop: true });
		await expectOk(await god('POST', sessionsPath(`/${sid}/heartbeat`)));
		await expectOk(await god('DELETE', sessionsPath(`/${sid}`)));
	});

	it('super admins do not bypass the per-user session cap', async () => {
		const god = createTestApi({
			bucket,
			userId: STRANGER,
			compute: makeFakeCompute(),
			deps: { policy: { superAdmins: [STRANGER], maxConcurrentSessionsPerUser: 1 } },
		}).request;
		await expectOk(await god('POST', sessionsPath()));
		const second = await createServices(bucket).notebooks.createNotebook(
			pid,
			{ title: 'NB2', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		await expectError(await god('POST', `/projects/${pid}/notebooks/${second.id}/sessions`), 429);
	});

	it('a super admin starts a real persisted session, never an ephemeral one', async () => {
		// Even under a viewer default with ephemeral-sandbox mode — which would
		// stamp a plain viewer's session `ephemeral` — the super admin resolves to
		// `admin`, so their session persists (edits are written back on teardown).
		const god = createTestApi({
			bucket,
			userId: STRANGER,
			compute: makeFakeCompute(),
			deps: {
				policy: {
					superAdmins: [STRANGER],
					defaultRole: 'viewer',
					viewerMode: 'ephemeral-sandbox',
				},
			},
		}).request;
		const data = await expectOk<ApiSession>(await god('POST', sessionsPath()));
		expect(data.status).toBe('running');
		expect(data.ephemeral).toBeUndefined();
		const stored = await createServices(bucket).sessions.getSession(pid, data.session_id);
		expect(stored.ephemeral).toBeFalsy();
	});

	it('DELETE /sessions/{sid} as a non-member returns 404 (no IDOR, no existence oracle)', async () => {
		// 404, not 403: a hidden project's session ids must be indistinguishable
		// from nonexistent ones (matches getSession).
		const sid = await startSession();
		await expectError(await stranger('DELETE', sessionsPath(`/${sid}`)), 404, 'NOT_FOUND');

		// The session must still be terminable by the owner — the denial did not act.
		await expectOk(await owner('DELETE', sessionsPath(`/${sid}`)));
	});

	it('DELETE /sessions/{sid} for a session in a different notebook/project returns 404 (scoping fix)', async () => {
		// A session that lives under a DIFFERENT project/notebook than the URL path.
		const otherServices = createServices(bucket);
		const foreignPid = createProjectId();
		const foreign = await otherServices.sessions.createSession({
			notebook_id: createNotebookId(),
			project_id: foreignPid,
			user_id: ACTOR,
		});

		// Owner of the path's project asks to delete it via the path's pid/nid.
		await expectError(
			await owner('DELETE', sessionsPath(`/${foreign.session_id}`)),
			404,
			'NOT_FOUND',
		);

		// The cross-scope session was NOT terminated (still loadable as starting).
		const stillThere = await otherServices.sessions.getSession(foreignPid, foreign.session_id);
		expect(stillThere.status).toBe('starting');
	});

	it('GET /sessions/{sid} 404s for a session under a DIFFERENT notebook in the same project', async () => {
		// A second notebook in the SAME project, with its own session.
		const otherNb = await createServices(bucket).notebooks.createNotebook(
			pid,
			{ title: 'NB2', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		const otherSession = await createServices(bucket).sessions.createSession({
			notebook_id: otherNb.id,
			project_id: pid,
			user_id: ACTOR,
		});

		// Fetch it through the FIRST notebook's path — project-scoped lookup finds it,
		// but the notebook_id mismatch must keep it out of scope (404).
		await expectError(
			await owner('GET', sessionsPath(`/${otherSession.session_id}`)),
			404,
			'NOT_FOUND',
		);
	});

	it('POST /sessions/{sid}/heartbeat 404s for a session under a DIFFERENT notebook', async () => {
		const otherNb = await createServices(bucket).notebooks.createNotebook(
			pid,
			{ title: 'NB2', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		const otherSession = await createServices(bucket).sessions.createSession({
			notebook_id: otherNb.id,
			project_id: pid,
			user_id: ACTOR,
		});

		await expectError(
			await owner('POST', sessionsPath(`/${otherSession.session_id}/heartbeat`)),
			404,
			'NOT_FOUND',
		);
	});

	it('POST /sessions/{sid}/heartbeat as a non-member returns 404 (no existence oracle)', async () => {
		const sid = await startSession();
		await expectError(await stranger('POST', sessionsPath(`/${sid}/heartbeat`)), 404, 'NOT_FOUND');
	});

	it('POST /sessions/{sid}/heartbeat happy path as the owner returns 200', async () => {
		const sid = await startSession();
		const data = await expectOk<ApiSession>(await owner('POST', sessionsPath(`/${sid}/heartbeat`)));
		expect(data.session_id).toBe(sid);
		expect(data.status).toBe('running');
	});

	it('DELETE /sessions/{sid} happy path as the owner returns 200', async () => {
		const sid = await startSession();
		await expectOk(await owner('DELETE', sessionsPath(`/${sid}`)));
	});

	it('DELETE /sessions/{sid} cuts a version from the sandbox edits and captures snapshots', async () => {
		const MOUNT = '/workspace';
		// A compute whose sandbox reports the session's edited files + marimo artifacts.
		const editing = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute({
				files: {
					[`${MOUNT}/notebook.py`]: 'import marimo as mo  # edited in kernel',
					[`${MOUNT}/__marimo__/notebook.html`]: '<html>rendered</html>',
					[`${MOUNT}/__marimo__/session/notebook.py.json`]: '{"version":"1"}',
				},
			}),
		}).request;

		const start = await expectOk<ApiSession>(await editing('POST', sessionsPath()));
		await expectOk(await editing('DELETE', sessionsPath(`/${start.session_id}`)));

		// Teardown cut a new version carrying the edit, plus the HTML + session snapshots.
		const services = createServices(bucket);
		const versions = await services.notebooks.listVersions(pid, nid);
		expect(versions).toHaveLength(2);
		expect(await services.notebooks.getNotebookContent(pid, nid)).toBe(
			'import marimo as mo  # edited in kernel',
		);
		const snapshotted = versions.find((v) => v.html_snapshot);
		expect(snapshotted).toBeDefined();
		expect(snapshotted!.session_snapshot).toBeTruthy();
		// The version is attributed to the session's owner.
		expect(snapshotted!.author).toBe(ACTOR);
	});

	it('GET /projects/{pid}/sessions lists active sessions and drops terminated ones', async () => {
		// No active sessions initially.
		expect(await expectPage<any>(await owner('GET', `/projects/${pid}/sessions`))).toEqual([]);

		const sid = await startSession();
		const active = await expectPage<any>(await owner('GET', `/projects/${pid}/sessions`));
		expect(active).toHaveLength(1);
		expect(active[0].session_id).toBe(sid);
		expect(active[0].notebook_id).toBe(nid);
		expect(active[0].status).toBe('running');

		// After shutdown the session is terminal and excluded from the active list.
		await expectOk(await owner('DELETE', sessionsPath(`/${sid}`)));
		expect(await expectPage<any>(await owner('GET', `/projects/${pid}/sessions`))).toEqual([]);
	});

	it('POST /sessions enforces the per-user concurrent-session cap (429)', async () => {
		// Cap the owner at 1 concurrent session.
		const capped = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			maxConcurrentSessionsPerUser: 1,
		}).request;

		// First session succeeds (running, counts toward the cap).
		await expectOk(await capped('POST', sessionsPath()));

		// A DIFFERENT notebook would be a second concurrent sandbox → rejected with 429
		// before provisioning. (Re-POSTing the SAME notebook would RESUME, not be capped.)
		const otherNb = await createServices(bucket).notebooks.createNotebook(
			pid,
			{ title: 'NB2', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		const otherPath = `/projects/${pid}/notebooks/${otherNb.id}/sessions`;
		const capRes = await capped('POST', otherPath);
		await expectError(capRes, 429, 'RESOURCE_EXHAUSTED');
		// A 429 carries a backoff hint so the client doesn't have to guess.
		expect(capRes.headers.get('Retry-After')).toBe('5');

		// Only the first notebook has a session record.
		expect(await createServices(bucket).sessions.listSessions(nid)).toHaveLength(1);
		expect(
			await createServices(bucket).sessions.listSessions(otherNb.id as NotebookId),
		).toHaveLength(0);
	});

	it('POST /sessions reuses an existing running session instead of provisioning anew', async () => {
		const first = await expectOk<ApiSession>(await owner('POST', sessionsPath()));
		const second = await expectOk<ApiSession>(await owner('POST', sessionsPath()));

		expect(second.session_id).toBe(first.session_id);
		expect(second.sandbox_url).toBe(first.sandbox_url);
		expect(first.reused).toBe(false);
		expect(second.reused).toBe(true);

		const all = await createServices(bucket).sessions.listSessions(nid);
		expect(all).toHaveLength(1);
	});

	it('POST /sessions hammered for one notebook reuses one record and never trips the cap', async () => {
		// Reproduces the refresh-10×-during-start bug: with a cap of 1, opening the
		// same notebook repeatedly must reuse the in-flight/running session rather than
		// piling up `starting` records and 429ing.
		const capped = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			maxConcurrentSessionsPerUser: 1,
		}).request;

		const ids = new Set<string>();
		for (let i = 0; i < 10; i++) {
			const data = await expectOk<ApiSession>(await capped('POST', sessionsPath()));
			ids.add(data.session_id);
		}
		expect(ids.size).toBe(1); // every refresh resolved to the same session
		expect(await createServices(bucket).sessions.listSessions(nid)).toHaveLength(1);
	});

	describe('dead kernel on reconnect', () => {
		it("reprovisions a fresh sandbox when a reused running session's kernel is dead", async () => {
			const { instance, calls } = makeFakeSandbox();
			const app = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(instance),
				deps: { kernelProbe: async () => 'dead' as const },
			}).request;

			// First open provisions a sandbox and goes running.
			const first = await expectOk<ApiSession>(await app('POST', sessionsPath()));
			expect(first.status).toBe('running');
			const startProcesses = calls.startProcess.length;

			// Reconnect: the kernel probes `dead`, so the wedged session is retired and a
			// NEW sandbox is provisioned (a new session id) instead of serving a 502.
			const second = await expectOk<ApiSession>(await app('POST', sessionsPath()));
			expect(second.status).toBe('running');
			expect(second.session_id).not.toBe(first.session_id);

			// The old sandbox was torn down and a fresh kernel was started.
			expect(calls.destroy).toBeGreaterThanOrEqual(1);
			expect(calls.startProcess.length).toBe(startProcesses + 1);

			// The old session is terminated; the fresh one is running.
			const all = await createServices(bucket).sessions.listSessions(nid);
			const byId = new Map(all.map((s) => [s.session_id, s.status]));
			expect(byId.get(first.session_id)).toBe('terminated');
			expect(byId.get(second.session_id)).toBe('running');
		});

		it('resumes a healthy reused session without reprovisioning (probe alive)', async () => {
			const { instance, calls } = makeFakeSandbox();
			const app = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(instance),
				deps: { kernelProbe: async () => 'alive' as const },
			}).request;

			const first = await expectOk<ApiSession>(await app('POST', sessionsPath()));
			const startProcesses = calls.startProcess.length;
			const second = await expectOk<ApiSession>(await app('POST', sessionsPath()));

			expect(second.session_id).toBe(first.session_id);
			expect(calls.startProcess.length).toBe(startProcesses); // no reprovision
			expect(calls.destroy).toBe(0);
		});

		it('does not probe (or retire) a reused session that is still starting', async () => {
			const probe = vi.fn(async () => 'dead' as const);
			const app = createTestApi({
				bucket,
				userId: ACTOR,
				compute: makeFakeCompute(),
				deps: { kernelProbe: probe },
			}).request;

			// Seed an in-flight `starting` session (no kernel yet) for this notebook.
			await createServices(bucket).sessions.createSession({
				notebook_id: nid,
				project_id: pid,
				user_id: ACTOR,
			});

			const data = await expectOk<ApiSession>(await app('POST', sessionsPath()));
			expect(data.status).toBe('starting');
			expect(probe).not.toHaveBeenCalled();
		});
	});

	it('GET /sessions/{sid} returns status; DELETE drives it to terminated', async () => {
		const sid = await startSession();

		const running = await expectOk<ApiSession>(await owner('GET', sessionsPath(`/${sid}`)));
		expect(running.status).toBe('running');

		await expectOk(await owner('DELETE', sessionsPath(`/${sid}`)));

		// Teardown finished → terminal, reflected by both the service and GET.
		expect((await createServices(bucket).sessions.getSession(pid, sid as never)).status).toBe(
			'terminated',
		);
		const after = await expectOk<ApiSession>(await owner('GET', sessionsPath(`/${sid}`)));
		expect(after.status).toBe('terminated');
	});

	it('POST /sessions: when provisioning fails, responds with an error and marks the session failed', async () => {
		// Owner app backed by a compute whose sandbox reachability check throws.
		const failOwner = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute({ failExec: 'true' }),
		}).request;
		const res = await failOwner('POST', sessionsPath());

		// The route re-throws the provisioning error (UnavailableError) → the real
		// onError maps it to 503 SERVICE_UNAVAILABLE, not a success response.
		expect(res.ok).toBe(false);
		await expectError(res, 503, 'SERVICE_UNAVAILABLE');
		// A 503 carries a backoff hint too.
		expect(res.headers.get('Retry-After')).toBe('2');

		// The session that was created before provisioning must end up failed, not
		// stuck in `starting`, AND carry a sanitized reason the client can render.
		const all = await createServices(bucket).sessions.listSessions(nid);
		expect(all).toHaveLength(1);
		expect(all[0].status).toBe('failed');
		expect(all[0].error?.code).toBe('SERVICE_UNAVAILABLE');
		expect(all[0].error?.message).toBeTruthy();
	});

	it('POST /sessions: provisioning failure self-destroys the partial sandbox', async () => {
		// Hold the sandbox instance so we can assert it was torn down. The reachability
		// check throws, so provisioning fails after the sandbox handle was created.
		const { instance, calls } = makeFakeSandbox({ failExec: 'true' });
		const failOwner = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(instance),
		}).request;

		await expectError(await failOwner('POST', sessionsPath()), 503, 'SERVICE_UNAVAILABLE');

		// SandboxProvisioner.provision destroys its partial sandbox on failure (the
		// saga never compensates the step that threw), and the session is marked failed by the saga compensation.
		expect(calls.destroy).toBeGreaterThanOrEqual(1);
		const all = await createServices(bucket).sessions.listSessions(nid);
		expect(all.every((s) => s.status === 'failed')).toBe(true);
	});

	describe('viewer mode', () => {
		const VIEWER = uid('user_viewer');
		const OTHER_VIEWER = uid('user_other_viewer');

		/** An app authenticated as `userId` whose deployment grants viewers via the default role. */
		const viewerModeApi = (
			userId: ReturnType<typeof uid>,
			viewerMode?: 'static' | 'ephemeral-sandbox',
			compute = makeFakeCompute(),
		) =>
			createTestApi({
				bucket,
				userId,
				compute,
				deps: { policy: { defaultRole: 'viewer', ...(viewerMode ? { viewerMode } : {}) } },
			}).request;

		it('static (the default): a viewer cannot start a session', async () => {
			const viewer = viewerModeApi(VIEWER);
			await expectError(await viewer('POST', sessionsPath()), 403, 'FORBIDDEN');
			expect(await createServices(bucket).sessions.listSessions(nid)).toHaveLength(0);
		});

		it('ephemeral-sandbox: a viewer gets a running session stamped ephemeral', async () => {
			const viewer = viewerModeApi(VIEWER, 'ephemeral-sandbox');
			const data = await expectOk<ApiSession>(await viewer('POST', sessionsPath()));
			expect(data.status).toBe('running');
			expect(data.ephemeral).toBe(true);
			expect(data.user_id).toBe(VIEWER);

			const stored = await createServices(bucket).sessions.getSession(pid, data.session_id);
			expect(stored.ephemeral).toBe(true);
		});

		it('an editor session stays persisting even in ephemeral-sandbox mode', async () => {
			const editor = viewerModeApi(ACTOR, 'ephemeral-sandbox');
			const data = await expectOk<ApiSession>(await editor('POST', sessionsPath()));
			expect(data.ephemeral).toBeUndefined();
		});

		it('a viewer can heartbeat and stop their OWN ephemeral session; another viewer cannot', async () => {
			const viewer = viewerModeApi(VIEWER, 'ephemeral-sandbox');
			const { session_id: sid } = await expectOk<ApiSession>(await viewer('POST', sessionsPath()));

			await expectOk(await viewer('POST', sessionsPath(`/${sid}/heartbeat`)));

			const other = viewerModeApi(OTHER_VIEWER, 'ephemeral-sandbox');
			await expectError(await other('POST', sessionsPath(`/${sid}/heartbeat`)), 403, 'FORBIDDEN');
			await expectError(await other('DELETE', sessionsPath(`/${sid}`)), 403, 'FORBIDDEN');

			await expectOk(await viewer('DELETE', sessionsPath(`/${sid}`)));
			const stored = await createServices(bucket).sessions.getSession(pid, sid);
			expect(stored.status).toBe('terminated');
		});

		it('never mounts the bucket into an ephemeral sandbox (copy-only)', async () => {
			const { instance, calls } = makeFakeSandbox();
			const viewer = viewerModeApi(VIEWER, 'ephemeral-sandbox', fakeComputeFrom(instance));

			const data = await expectOk<ApiSession>(await viewer('POST', sessionsPath()));
			expect(data.ephemeral).toBe(true);
			expect(calls.mountBucket).toHaveLength(0);
			// Copy-only: the workspace is written in (batched), never mounted.
			expect(calls.writeFiles.flat().length).toBeGreaterThan(0);
		});

		it('revoking the viewer role cuts heartbeat/stop of a live ephemeral session', async () => {
			const viewer = viewerModeApi(VIEWER, 'ephemeral-sandbox');
			const { session_id: sid } = await expectOk<ApiSession>(await viewer('POST', sessionsPath()));

			// Same user, but the deployment no longer grants them any role (e.g. the
			// default role was dropped / membership revoked): ownership alone must
			// not keep the kernel alive.
			const revoked = createTestApi({
				bucket,
				userId: VIEWER,
				compute: makeFakeCompute(),
			}).request;
			// 404, not 403: with no role the project itself is hidden, and a hidden
			// project's session ids read as nonexistent.
			await expectError(await revoked('POST', sessionsPath(`/${sid}/heartbeat`)), 404, 'NOT_FOUND');
			await expectError(await revoked('DELETE', sessionsPath(`/${sid}`)), 404, 'NOT_FOUND');
		});

		it('a role change retires the old-class session instead of reusing it', async () => {
			const viewer = viewerModeApi(VIEWER, 'ephemeral-sandbox');
			const first = await expectOk<ApiSession>(await viewer('POST', sessionsPath()));
			expect(first.ephemeral).toBe(true);

			// Promoted to editor (default role now editor): the ephemeral session must
			// not be reused — its edits would be silently discarded at teardown.
			const editor = createTestApi({
				bucket,
				userId: VIEWER,
				compute: makeFakeCompute(),
				deps: { policy: { defaultRole: 'editor', viewerMode: 'ephemeral-sandbox' } },
			}).request;
			const second = await expectOk<ApiSession>(await editor('POST', sessionsPath()));
			expect(second.reused).toBe(false);
			expect(second.session_id).not.toBe(first.session_id);
			expect(second.ephemeral).toBeUndefined();

			const stored = await createServices(bucket).sessions.getSession(pid, first.session_id);
			expect(stored.status).toBe('terminated');
		});

		it("a viewer cannot stop an editor's (persisting) session", async () => {
			const sid = await startSession();
			const viewer = viewerModeApi(VIEWER, 'ephemeral-sandbox');
			await expectError(await viewer('DELETE', sessionsPath(`/${sid}`)), 403, 'FORBIDDEN');
		});

		it('stopping an ephemeral session persists nothing (no version cut)', async () => {
			// The sandbox holds edits that a persisting teardown WOULD commit.
			const compute = makeFakeCompute({
				files: {
					'/workspace/notebook.py': 'print(2)  # viewer edit',
					'/workspace/__marimo__/notebook.html': '<html>x</html>',
				},
			});
			const viewer = viewerModeApi(VIEWER, 'ephemeral-sandbox', compute);
			const { session_id: sid } = await expectOk<ApiSession>(await viewer('POST', sessionsPath()));

			await expectOk(await viewer('DELETE', sessionsPath(`/${sid}`)));

			expect(await createServices(bucket).notebooks.listVersions(pid, nid)).toHaveLength(1);
		});
	});

	describe('Workload Identity Federation', () => {
		// Deployment WIF capability: a stub issuer (only `mint` is used) + the single
		// federation target whose broker runs `exchange`. Cast past the issuer's class shape.
		const wifDeps = (exchange: () => Promise<unknown>) =>
			({
				wif: {
					issuer: { mint: async () => 'jwt.value', jwks: async () => ({ keys: [] }) },
					issuerUrl: 'https://hub.example.com',
					target: {
						broker: { exchange },
						audience: 'coreweave-object-storage',
						storage: { endpoint: 'https://cwobject.com', region: 'us-east-1' },
					},
				},
			}) as unknown as Partial<ApiDeps>;

		const goodExchange = async () => ({
			accessKeyId: 'CWAK',
			secretAccessKey: 'sk',
			sessionToken: 'tok',
		});

		/** Opt the seeded project into federation. */
		const enableFederation = () =>
			createServices(bucket).projects.updateProject(pid, { federation: { enabled: true } }, ACTOR);

		it('injects federated S3 creds when WIF is on AND the project opted in', async () => {
			await enableFederation();
			const { instance, calls } = makeFakeSandbox();
			const req = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(instance),
				deps: wifDeps(goodExchange),
			}).request;

			const data = await expectOk<ApiSession>(await req('POST', sessionsPath()));
			expect(data.status).toBe('running');
			expect(calls.setEnvVars).toHaveLength(1);
			expect(calls.setEnvVars[0]).toMatchObject({
				AWS_ACCESS_KEY_ID: 'CWAK',
				AWS_SECRET_ACCESS_KEY: 'sk',
				AWS_SESSION_TOKEN: 'tok',
				AWS_ENDPOINT_URL_S3: 'https://cwobject.com',
				AWS_REGION: 'us-east-1',
			});
		});

		it('does NOT inject when WIF is on but the project did not opt in', async () => {
			const { instance, calls } = makeFakeSandbox();
			const req = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(instance),
				deps: wifDeps(goodExchange),
			}).request;

			await expectOk<ApiSession>(await req('POST', sessionsPath()));
			expect(calls.setEnvVars.flatMap(Object.keys)).not.toContain('AWS_ACCESS_KEY_ID');
		});

		it('still provisions when the credential exchange fails (non-fatal)', async () => {
			await enableFederation();
			const { instance, calls } = makeFakeSandbox();
			const req = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(instance),
				deps: wifDeps(async () => {
					throw new Error('bucket policy denied');
				}),
			}).request;

			const data = await expectOk<ApiSession>(await req('POST', sessionsPath()));
			expect(data.status).toBe('running');
			expect(calls.setEnvVars.flatMap(Object.keys)).not.toContain('AWS_ACCESS_KEY_ID');
		});

		it("never injects creds into a viewer's ephemeral session, even when opted in", async () => {
			await enableFederation();
			const { instance, calls } = makeFakeSandbox();
			const req = createTestApi({
				bucket,
				userId: uid('user_viewer'),
				compute: fakeComputeFrom(instance),
				deps: {
					...wifDeps(goodExchange),
					policy: { defaultRole: 'viewer', viewerMode: 'ephemeral-sandbox' },
				},
			}).request;

			const data = await expectOk<ApiSession>(await req('POST', sessionsPath()));
			expect(data.ephemeral).toBe(true);
			expect(calls.setEnvVars.flatMap(Object.keys)).not.toContain('AWS_ACCESS_KEY_ID');
		});

		it('does not inject creds when WIF is unconfigured at the deployment', async () => {
			await enableFederation();
			const { instance, calls } = makeFakeSandbox();
			const req = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(instance),
			}).request;

			await expectOk<ApiSession>(await req('POST', sessionsPath()));
			expect(calls.setEnvVars.flatMap(Object.keys)).not.toContain('AWS_ACCESS_KEY_ID');
		});
	});

	describe('Project secrets', () => {
		const stubResolver = { backend: 'aws-sm', resolve: async (r: any) => `resolved:${r.locator}` };

		// Deployment WIF stub whose exchange injects AWS_REGION=us-east-1 (used to
		// prove a hub-managed var wins a collision with a project secret).
		const wifRegionDeps = {
			wif: {
				issuer: { mint: async () => 'jwt.value', jwks: async () => ({ keys: [] }) },
				issuerUrl: 'https://hub.example.com',
				target: {
					broker: {
						exchange: async () => ({
							accessKeyId: 'CWAK',
							secretAccessKey: 'sk',
							sessionToken: 'tok',
						}),
					},
					audience: 'coreweave-object-storage',
					storage: { endpoint: 'https://cwobject.com', region: 'us-east-1' },
				},
			},
		} as unknown as Partial<ApiDeps>;

		/** A provider whose resolve is fully controlled (bypasses the name guard). */
		const fakeSecrets = (resolve: () => Promise<Record<string, string>>): Partial<ApiDeps> => ({
			secrets: {
				list: async () => [],
				put: async () => {
					throw new Error('unused');
				},
				delete: async () => {},
				validate: async () => {},
				resolve,
			},
		});

		it('injects resolved project secrets into the sandbox env', async () => {
			const secrets = new ProjectSecretsStore({ bucket, resolvers: [stubResolver] });
			await secrets.put(
				pid,
				'MY_SECRET',
				{
					kind: 'reference',
					ref: { backend: 'aws-sm', locator: 'prod/x' },
				},
				ACTOR,
			);

			const { instance, calls } = makeFakeSandbox();
			const req = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(instance),
				deps: { secrets },
			}).request;

			await expectOk<ApiSession>(await req('POST', sessionsPath()));
			expect(calls.setEnvVars).toHaveLength(1);
			expect(calls.setEnvVars[0]).toMatchObject({ MY_SECRET: 'resolved:prod/x' });
		});

		it('fans a JSON secret out into multiple sandbox env vars', async () => {
			const jsonResolver = {
				backend: 'aws-sm',
				resolve: async () => JSON.stringify({ API_KEY: 'a', DB_URL: 'b' }),
			};
			const secrets = new ProjectSecretsStore({ bucket, resolvers: [jsonResolver] });
			await secrets.put(
				pid,
				'BUNDLE',
				{ kind: 'reference', ref: { backend: 'aws-sm', locator: 'prod/all', expand: 'json' } },
				ACTOR,
			);

			const { instance, calls } = makeFakeSandbox();
			const req = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(instance),
				deps: { secrets },
			}).request;

			await expectOk<ApiSession>(await req('POST', sessionsPath()));
			expect(calls.setEnvVars[0]).toMatchObject({ API_KEY: 'a', DB_URL: 'b' });
		});

		it('a hub-managed (WIF) var wins a name collision with a secret', async () => {
			await createServices(bucket).projects.updateProject(
				pid,
				{ federation: { enabled: true } },
				ACTOR,
			);
			const { instance, calls } = makeFakeSandbox();
			const req = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(instance),
				deps: {
					...wifRegionDeps,
					...fakeSecrets(async () => ({ AWS_REGION: 'evil', SAFE: 'ok' })),
				},
			}).request;

			await expectOk<ApiSession>(await req('POST', sessionsPath()));
			expect(calls.setEnvVars[0]).toMatchObject({ AWS_REGION: 'us-east-1', SAFE: 'ok' });
		});

		it('fails create closed (503) and provisions nothing when resolve throws', async () => {
			const { instance, calls } = makeFakeSandbox();
			const req = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(instance),
				deps: fakeSecrets(async () => {
					throw new Error('secret OPENAI_API_KEY: access denied');
				}),
			}).request;

			await expectError(await req('POST', sessionsPath()), 503);
			expect(calls.setEnvVars).toHaveLength(0);
		});

		it('never injects secrets into a viewer ephemeral session', async () => {
			const secrets = new ProjectSecretsStore({ bucket, resolvers: [stubResolver] });
			await secrets.put(
				pid,
				'MY_SECRET',
				{
					kind: 'reference',
					ref: { backend: 'aws-sm', locator: 'prod/x' },
				},
				ACTOR,
			);

			const { instance, calls } = makeFakeSandbox();
			const req = createTestApi({
				bucket,
				userId: uid('user_viewer'),
				compute: fakeComputeFrom(instance),
				deps: { secrets, policy: { defaultRole: 'viewer', viewerMode: 'ephemeral-sandbox' } },
			}).request;

			const data = await expectOk<ApiSession>(await req('POST', sessionsPath()));
			expect(data.ephemeral).toBe(true);
			expect(calls.setEnvVars.flatMap(Object.keys)).not.toContain('MY_SECRET');
		});
	});
});
