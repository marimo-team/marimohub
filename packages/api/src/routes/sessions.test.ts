import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	BadRequestError,
	createNotebookId,
	createProjectId,
	createServices,
	Millis,
	paths,
} from '@marimo-hub/core';
import type { NotebookId, ProjectId, SandboxInstance, Session, SessionId } from '@marimo-hub/core';
import {
	ACTOR,
	fakeComputeFrom,
	makeFakeCompute,
	makeFakeSandbox,
	makeSession,
	MemoryNotifier,
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
const MANAGER = uid('user_manager');
type ApiSession = Session & {
	can: { attach: boolean; stop: boolean; surfaces?: { vscode: boolean; opencode: boolean } };
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

	it('logs resolved provisioning context and best-effort integration warnings', async () => {
		const warning =
			'Integration "staging" uses its notebook snippet because "prod" owns automatic discovery.';
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const request = createTestApi({
				bucket,
				userId: ACTOR,
				compute: makeFakeCompute(),
				deps: {
					sandbox: sandboxConfig({
						images: ['registry.example/marimo:py313'],
						computeProfile: 'gpu',
					}),
					integrations: {
						resolveForSession: async () => ({
							files: [],
							vars: {},
							attachments: [],
							warnings: [warning],
						}),
					} as never,
				},
			}).request;

			const session = await expectOk<ApiSession>(await request('POST', sessionsPath()));
			const line = log.mock.calls.find((call) =>
				String(call[0]).includes('session_provision'),
			)?.[0];
			expect(JSON.parse(String(line))).toMatchObject({
				session_id: session.session_id,
				image: 'registry.example/marimo:py313',
				compute_profile: 'gpu',
				integration_warning_count: 1,
				integration_warnings: [warning],
			});
		} finally {
			log.mockRestore();
		}
	});

	it('POST /sessions with a non-existent notebook returns 404 and does not provision', async () => {
		// Use a notebook id that was never created in this project.
		const bogusNid = createNotebookId();
		const path = `/projects/${pid}/notebooks/${bogusNid}/sessions`;
		await expectError(await owner('POST', path), 404, 'NOT_FOUND');

		// No session record should have been created.
		const all = await createServices(bucket).sessions.listSessions(bogusNid);
		expect(all).toHaveLength(0);
	});

	it('POST /sessions for an unsynced GitHub notebook returns 409 and does not provision', async () => {
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

		await expectError(await owner('POST', path), 409, 'CONFLICT');
		expect(await services.sessions.listSessions(meta.id)).toHaveLength(0);
	});

	describe('launch strategy inference', () => {
		const enc = (s: string) => new TextEncoder().encode(s);
		const INLINE_CODE = '# /// script\n# dependencies = ["cowsay==6.1"]\n# ///\nimport cowsay';
		// Nested on purpose: catches a workspace-relative vs repo-relative join bug.
		const ENTRY = 'apps/dash.py';

		async function createSyncedNotebook(
			entryCode: string,
			syncMode: 'push' | 'pull' = 'push',
		): Promise<NotebookId> {
			const services = createServices(bucket);
			const { meta } = await services.notebooks.synced.create(
				pid,
				{
					title: 'GitHub NB',
					description: 'd',
					repo: 'org/repo',
					branch: 'main',
					entry_notebook: ENTRY,
					sync_mode: syncMode,
				},
				ACTOR,
			);
			await services.notebooks.synced.sync(pid, meta.id, {
				repo: 'org/repo',
				branch: 'main',
				root_path: '',
				commit: 'commit-aaaa',
				files: [{ path: ENTRY, bytes: enc(entryCode) }],
				...(syncMode === 'pull'
					? { git_files: [{ path: 'HEAD', bytes: enc('ref: refs/heads/main\n') }] }
					: {}),
			});
			return meta.id;
		}

		const entryReads = (spy: { mock: { calls: unknown[][] } }) =>
			spy.mock.calls.filter(([key]) => String(key).endsWith(ENTRY)).length;
		const archiveReads = (spy: { mock: { calls: unknown[][] } }) =>
			spy.mock.calls.filter(([key]) => String(key).endsWith('/workspace.zip')).length;

		async function startSessionApi(notebookId: NotebookId) {
			const sb = makeFakeSandbox();
			const api = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(sb.instance),
			}).request;
			return {
				sb,
				post: () => api('POST', `/projects/${pid}/notebooks/${notebookId}/sessions`),
			};
		}

		it('installs PEP 723 pins for a git-synced entry notebook that declares them', async () => {
			const synced = await createSyncedNotebook(INLINE_CODE);
			const { sb, post } = await startSessionApi(synced);
			await expectOk<ApiSession>(await post());
			const cmd = sb.calls.exec.find((command) => command.includes('uv sync --inexact'))!;
			expect(cmd).toContain("uv export --script 'apps/dash.py'");
			expect(cmd).toContain('uv pip install');
			// The repo pyproject layer still applies underneath the pins.
			expect(cmd).toContain('uv sync --inexact');
		});

		it('uses a packed pull workspace and the project-managed env without inline metadata', async () => {
			const synced = await createSyncedNotebook('import marimo', 'pull');
			const get = vi.spyOn(bucket, 'get');
			const { sb, post } = await startSessionApi(synced);
			await expectOk<ApiSession>(await post());
			const extract = sb.calls.exec.find(
				(command) =>
					command.startsWith('python3 ') &&
					command.includes('/workspace/.marimohub-packed-restore/extract.py'),
			)!;
			expect(extract).toMatch(/ 1$/);
			expect(archiveReads(get)).toBe(1);
			// Launch-strategy detection reads the entry once; a canonical fallback would read it again.
			expect(entryReads(get)).toBe(1);
			const setup = sb.calls.exec.find((command) => command.includes('uv sync --inexact'))!;
			expect(setup).not.toContain('uv export');
		});

		it('ignores inline metadata in a local notebook (deps live in pyproject.toml)', async () => {
			const services = createServices(bucket);
			const local = await services.notebooks.createNotebook(
				pid,
				{ title: 'Local NB', description: 'd', code: INLINE_CODE },
				ACTOR,
			);
			const { sb, post } = await startSessionApi(local.id as NotebookId);
			await expectOk<ApiSession>(await post());
			const setup = sb.calls.exec.find((command) => command.includes('uv sync --inexact'))!;
			expect(setup).not.toContain('uv export');
		});

		it('does not re-read the entry file when reusing an existing session', async () => {
			const synced = await createSyncedNotebook(INLINE_CODE);
			const { post } = await startSessionApi(synced);
			await expectOk<ApiSession>(await post());
			const get = vi.spyOn(bucket, 'get');
			const reused = await expectOk<ApiSession>(await post());
			expect(reused.reused).toBe(true);
			expect(entryReads(get)).toBe(0);
		});

		it('still starts the session with the default strategy when the entry file is unreadable', async () => {
			const synced = await createSyncedNotebook(INLINE_CODE);
			// Simulate a torn read of the immutable workspace (object missing).
			const { objects } = await bucket.list();
			const entryKey = objects.find((o) => o.key.endsWith(ENTRY))!.key;
			await bucket.delete(entryKey);
			const { sb, post } = await startSessionApi(synced);
			await expectOk<ApiSession>(await post());
			const setup = sb.calls.exec.find((command) => command.includes('uv sync --inexact'))!;
			expect(setup).not.toContain('uv export');
		});

		it('rejects an unsynced notebook before reading any entry file', async () => {
			const services = createServices(bucket);
			const { meta } = await services.notebooks.synced.create(
				pid,
				{
					title: 'Unsynced',
					description: 'd',
					repo: 'org/repo',
					branch: 'main',
					entry_notebook: ENTRY,
				},
				ACTOR,
			);
			const get = vi.spyOn(bucket, 'get');
			await expectError(
				await owner('POST', `/projects/${pid}/notebooks/${meta.id}/sessions`),
				409,
				'CONFLICT',
			);
			expect(entryReads(get)).toBe(0);
		});
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

	it('uses the configured sandbox startup timeout to bound the kernel port wait', async () => {
		const sb = makeFakeSandbox();
		const api = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(sb.instance),
			deps: { sandbox: sandboxConfig({ startupTimeoutMs: Millis.seconds(300) }) },
		}).request;
		await expectOk<ApiSession>(await api('POST', sessionsPath()));
		expect(sb.calls.waitForPortOptions).toHaveLength(1);
		const timeout = sb.calls.waitForPortOptions[0]!.timeout;
		expect(timeout).toBeGreaterThan(299_000);
		expect(timeout).toBeLessThanOrEqual(300_000);
	});

	it('surfaces a startup timeout as a 503 naming the timeout, on the response AND the record', async () => {
		const sb = makeFakeSandbox({
			failWaitForPort: new Error('timed out'),
			logs: { stdout: 'Resolved 42 packages', stderr: '' },
		});
		const api = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(sb.instance),
			// 0ms: the fake's instant rejection has already consumed the window, so
			// the provisioner classifies it as a timeout without a real 2-minute wait.
			deps: { sandbox: sandboxConfig({ startupTimeoutMs: Millis.of(0) }) },
		}).request;

		const error = await expectError(await api('POST', sessionsPath()), 503, 'SERVICE_UNAVAILABLE');
		expect(error.message).toContain('startup timeout');
		expect(error.message).toContain('MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS');
		expect(error.message).toContain('Resolved 42 packages');

		// A client polling GET …/sessions/{sid} sees the same reason on the record.
		const [record] = await createServices(bucket).sessions.listSessions(nid);
		expect(record.status).toBe('failed');
		expect(record.error?.message).toContain('startup timeout');
	});

	it('serves the sandbox startup timeout on /capabilities', async () => {
		const defaults = await expectOk<{ sandbox_startup_timeout_seconds: number }>(
			await owner('GET', '/capabilities'),
		);
		expect(defaults.sandbox_startup_timeout_seconds).toBe(120);

		const configured = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			deps: { sandbox: sandboxConfig({ startupTimeoutMs: Millis.seconds(300) }) },
		}).request;
		const overridden = await expectOk<{ sandbox_startup_timeout_seconds: number }>(
			await configured('GET', '/capabilities'),
		);
		expect(overridden.sandbox_startup_timeout_seconds).toBe(300);
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

	it('provisions persistent and temporary exclusive editors with their own homes', async () => {
		const resolve = vi.fn((user: { email: string }) => ({
			key: user.email,
			path: `/mnt/${user.email}`,
		}));
		const home = { resolve };
		const ownerCompute = makeFakeCompute();
		const otherCompute = makeFakeCompute();
		const exclusiveOwner = exclusiveApi(ACTOR, ownerCompute, {
			sandbox: sandboxConfig({ userHome: home }),
		});
		const exclusiveOther = exclusiveApi(STRANGER, otherCompute, {
			sandbox: sandboxConfig({ userHome: home }),
		});

		await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		expect(ownerCompute.lastCreateOptions?.userHome).toEqual({
			key: `${ACTOR}@example.com`,
			path: `/mnt/${ACTOR}@example.com`,
		});

		await expectOk<ApiSession>(
			await exclusiveOther('POST', sessionsPath(), { edit_intent: 'temporary' }),
		);
		expect(otherCompute.lastCreateOptions?.userHome).toEqual({
			key: `${STRANGER}@example.com`,
			path: `/mnt/${STRANGER}@example.com`,
		});
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it('does not provision shared apps with an editor personal home', async () => {
		const compute = makeFakeCompute();
		const resolve = vi.fn(() => ({ key: 'owner@example.com', path: '/mnt/owner@example.com' }));
		const request = exclusiveApi(ACTOR, compute, {
			sandbox: sandboxConfig({ userHome: { resolve } }),
		});

		await expectOk<ApiSession>(await request('POST', sessionsPath(), { mode: 'app' }));
		expect(compute.lastCreateOptions?.userHome).toBeUndefined();
		expect(resolve).not.toHaveBeenCalled();
	});

	it('returns an actionable client error when personal storage cannot resolve the email', async () => {
		const compute = makeFakeCompute();
		const request = exclusiveApi(ACTOR, compute, {
			sandbox: sandboxConfig({
				userHome: {
					resolve() {
						throw new BadRequestError(
							'Your authenticated email cannot be used for personal storage',
						);
					},
				},
			}),
		});

		const error = await expectError(await request('POST', sessionsPath()), 400, 'BAD_REQUEST');
		expect(error.message).toContain('authenticated email cannot be used for personal storage');
		expect(compute.lastCreateOptions).toBeUndefined();
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
		const notifier = new MemoryNotifier();
		const exclusiveOwner = exclusiveApi(ACTOR, ownerCompute);
		const exclusiveOther = exclusiveApi(STRANGER, otherCompute, {
			policy: { maxConcurrentSessionsPerUser: 1 },
			notifier,
		});
		const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		const temporary = await expectOk<ApiSession>(
			await exclusiveOther('POST', sessionsPath(), { edit_intent: 'temporary' }),
		);
		const state = await expectOk<EditorState>(await exclusiveOther('GET', editorSessionPath()));
		expect(state.holder?.user_id).toBe(ACTOR);
		expect(state.can_take_over).toBe(true);
		const takeoverRequest = {
			takeover_id: 'takeover-test-1',
			expected_holder_session_id: persistent.session_id,
			expected_activity: state.holder!.activity.state,
			acknowledge_disruption: true,
		};
		await expectOk(await exclusiveOther('POST', editorSessionPath('/takeover'), takeoverRequest));
		await vi.waitFor(() => expect(notifier.deliveries).toHaveLength(2));
		await expectOk(await exclusiveOther('POST', editorSessionPath('/takeover'), takeoverRequest));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(notifier.attempts).toBe(2);
		const replacement = await expectOk<ApiSession>(await exclusiveOther('POST', sessionsPath()));
		expect(replacement.user_id).toBe(STRANGER);
		expect(replacement.session_id).not.toBe(persistent.session_id);
		const old = await createServices(bucket).sessions.getSession(pid, persistent.session_id);
		expect(old.status).toBe('terminated');
		expect(old.ended_reason).toBe('takeover');
		expect(old.ended_by_user_id).toBe(STRANGER);
		const discarded = await createServices(bucket).sessions.getSession(pid, temporary.session_id);
		expect(discarded.status).toBe('terminated');
		expect(notifier.deliveries[0]).toMatchObject({
			kind: 'session.takeover',
			audience: 'personal',
			title: 'Your editor session was taken over',
			recipients: [{ userId: ACTOR, email: `${ACTOR}@example.com` }],
			context: { pid, nid, takeover_id: 'takeover-test-1' },
			dedupe_key: 'session.takeover:takeover-test-1:personal',
		});
		expect(notifier.deliveries[1]).toMatchObject({
			kind: 'session.takeover',
			audience: 'broadcast',
			recipients: [],
			dedupe_key: 'session.takeover:takeover-test-1:broadcast',
		});
	});

	it('checks the displaced recipient after atomically reserving a takeover', async () => {
		const notifier = new MemoryNotifier();
		const holderApi = exclusiveApi(STRANGER);
		const persistent = await expectOk<ApiSession>(await holderApi('POST', sessionsPath()));
		const services = createServices(bucket);
		const other = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			deps: {
				services,
				notifier,
				policy: { editorSandboxSharing: 'exclusive', defaultRole: 'editor' },
			},
		});
		for (let index = 0; index < 5; index++) {
			await expectOk(
				await other.request('POST', `/projects/${pid}/members`, {
					user_id: STRANGER,
					role: 'editor',
				}),
				201,
			);
			await expectOk(await other.request('DELETE', `/projects/${pid}/members/${STRANGER}`));
		}
		await vi.waitFor(() => expect(notifier.attempts).toBeGreaterThanOrEqual(5));
		const attemptsBeforeTakeover = notifier.attempts;
		const actualClaim = await services.sessions.getEditorClaim(pid, nid);
		vi.spyOn(services.sessions, 'getEditorClaim').mockResolvedValueOnce({
			...actualClaim!,
			session_id: 'sess-stale-observation' as SessionId,
		});

		await expectError(
			await other.request('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-recipient-race',
				expected_holder_session_id: persistent.session_id,
				expected_activity: 'unknown',
				acknowledge_disruption: true,
			}),
			429,
			'RESOURCE_EXHAUSTED',
		);
		expect((await services.sessions.getEditorClaim(pid, nid))?.transfer).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(notifier.attempts).toBe(attemptsBeforeTakeover);
	});

	it('does not fail a takeover when notification delivery fails', async () => {
		const notifier = new MemoryNotifier();
		notifier.failNext();
		const exclusiveOwner = exclusiveApi(ACTOR);
		const exclusiveOther = exclusiveApi(STRANGER, makeFakeCompute(), { notifier });
		const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		const state = await expectOk<EditorState>(await exclusiveOther('GET', editorSessionPath()));

		await expectOk(
			await exclusiveOther('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-notify-failure',
				expected_holder_session_id: persistent.session_id,
				expected_activity: state.holder!.activity.state,
				acknowledge_disruption: true,
			}),
		);
		await vi.waitFor(() => expect(notifier.attempts).toBe(2));
		expect(notifier.deliveries).toHaveLength(1);
		expect(notifier.deliveries[0]?.audience).toBe('broadcast');
	});

	it('renders takeover notifications once and keeps project alerts when identity lookup fails', async () => {
		const notifier = new MemoryNotifier();
		const deliver = vi.fn(async () => 'delivered' as const);
		const services = createServices(bucket);
		const getIdentity = services.identities.get.bind(services.identities);
		const identityLookup = vi
			.spyOn(services.identities, 'get')
			.mockImplementation((userId) =>
				userId === ACTOR
					? Promise.reject(new Error('identity store unavailable'))
					: getIdentity(userId),
			);
		const exclusiveOwner = exclusiveApi(ACTOR);
		const exclusiveOther = exclusiveApi(STRANGER, makeFakeCompute(), {
			services,
			notifier,
			projectAlerts: {
				store: {} as never,
				dispatcher: { deliver, test: vi.fn() },
				maxDestinations: 10,
			},
		});
		const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		const state = await expectOk<EditorState>(await exclusiveOther('GET', editorSessionPath()));

		await expectOk(
			await exclusiveOther('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-identity-failure',
				expected_holder_session_id: persistent.session_id,
				expected_activity: state.holder!.activity.state,
				acknowledge_disruption: true,
			}),
		);
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
		expect(identityLookup.mock.calls.filter(([userId]) => userId === ACTOR)).toHaveLength(1);
		expect(notifier.attempts).toBe(2);
		expect(deliver).toHaveBeenCalledWith(
			pid,
			'session.takeover',
			expect.objectContaining({
				audience: 'broadcast',
				data: expect.objectContaining({ displaced_user_id: ACTOR }),
			}),
		);
	});

	it('does not offer takeover when a claim names a terminal session', async () => {
		const services = createServices(bucket);
		const exclusiveOwner = exclusiveApi(ACTOR);
		const exclusiveOther = exclusiveApi(STRANGER);
		const persistent = await expectOk<ApiSession>(await exclusiveOwner('POST', sessionsPath()));
		await services.sessions.terminate(pid, persistent.session_id as SessionId);

		const state = await expectOk<EditorState>(await exclusiveOther('GET', editorSessionPath()));

		expect(state.holder).toBeNull();
		expect(state.can_take_over).toBe(false);
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
			409,
			'CONFLICT',
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
			return {
				success: false,
				stdout: '',
				stderr: '',
				error: { code: 'COMMAND_FAILED' },
			};
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
			return {
				success: false,
				stdout: '',
				stderr: '',
				error: { code: 'COMMAND_FAILED' },
			};
		};
		const exclusiveOther = exclusiveApi(STRANGER, fakeComputeFrom(activity.instance));

		await expectError(
			await exclusiveOther('POST', editorSessionPath('/takeover'), {
				takeover_id: 'takeover-reconciled',
				expected_holder_session_id: persistent.session_id,
				expected_activity: 'unknown',
				acknowledge_disruption: true,
			}),
			409,
			'CONFLICT',
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

		it('falls back to the default image and logs without the stored value', async () => {
			const meta = await createServices(bucket).notebooks.getNotebook(pid, nid);
			await bucket.put(
				`projects/${pid}/notebooks/${nid}/meta.json`,
				JSON.stringify({ ...meta.meta, base_image: 'img-gone' }),
			);

			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			try {
				const compute = makeFakeCompute();
				await expectOk<ApiSession>(await imageApi(compute)('POST', sessionsPath()));
				expect(compute.lastCreateOptions).toMatchObject({ image: 'img-a' });
				const line = log.mock.calls.find((c) =>
					String(c[0]).includes('stored_config_fallback'),
				)?.[0] as string;
				expect(line).toContain('selection_unavailable');
				expect(line).not.toContain('img-gone');
			} finally {
				log.mockRestore();
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
					resources: { cpu: 0.5, memoryBytes: 512 * 1024 ** 2, gpu: 'T4' },
					computeProfile: 'small',
				}),
			},
		}).request;

		const data = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		expect(compute.lastCreateOptions?.resources).toEqual({
			cpu: 0.5,
			memoryBytes: 512 * 1024 ** 2,
			gpu: 'T4',
		});
		expect(data.compute_profile).toBe('small');
		expect(data.compute_resources).toEqual({
			cpu: 0.5,
			memory_bytes: 512 * 1024 ** 2,
			gpu: 'T4',
		});
		expect(data.compute_from_snapshot).toBeUndefined();
		const stored = await createServices(bucket).sessions.getSession(pid, data.session_id);
		expect(stored.compute_profile).toBe('small');
		expect(stored.compute_resources).toEqual({
			cpu: 0.5,
			memory_bytes: 512 * 1024 ** 2,
			gpu: 'T4',
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
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
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
			const line = log.mock.calls.find((call) =>
				String(call[0]).includes('stored_config_fallback'),
			)?.[0] as string;
			expect(line).toContain('selection_unavailable');
			expect(line).not.toContain('removed');
		} finally {
			log.mockRestore();
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

	it('persists the entitlement JWT expiry as a separate non-extendable authorization deadline', async () => {
		const authorizationExpiresAt = new Date(Date.now() + Millis.minutes(30)).toISOString();
		const groupEditor = createTestApi({
			bucket,
			userId: STRANGER,
			compute: makeFakeCompute(),
			deps: {
				authenticator: {
					authenticate: async () => ({
						credential: { kind: 'development' },
						id: STRANGER,
						email: `${STRANGER}@example.com`,
						entitlements: ['default-role:editor'],
						entitlementsExpiresAt: authorizationExpiresAt,
					}),
				},
				sandbox: sandboxConfig({
					sessionLifetime: {
						maxLifetimeMs: Millis.hours(4),
						idleTimeoutMs: Millis.minutes(30),
						snapshotIntervalMs: Millis.minutes(2),
						extensionMs: Millis.minutes(30),
						connectionAware: true,
						sweepIntervalMs: Millis.seconds(60),
					},
				}),
			},
		}).request;

		const data = await expectOk<ApiSession>(await groupEditor('POST', sessionsPath()));
		const stored = await createServices(bucket).sessions.getSession(pid, data.session_id);

		expect(stored.authorization_expires_at).toBe(authorizationExpiresAt);
		expect(Date.parse(stored.expires_at!)).toBeGreaterThan(Date.parse(authorizationExpiresAt));
	});

	it('fails closed when an entitlement-bearing authenticator omits its credential expiry', async () => {
		const groupEditor = createTestApi({
			bucket,
			userId: STRANGER,
			compute: makeFakeCompute(),
			deps: {
				authenticator: {
					authenticate: async () => ({
						credential: { kind: 'development' },
						id: STRANGER,
						email: `${STRANGER}@example.com`,
						entitlements: ['default-role:editor'],
					}),
				},
			},
		}).request;

		await expectError(await groupEditor('POST', sessionsPath()), 403, 'FORBIDDEN');
		expect(
			(await createServices(bucket).sessions.listSessions()).filter(
				(session) => session.user_id === STRANGER,
			),
		).toHaveLength(0);
	});

	it.each([
		['malformed', 'not-a-timestamp'],
		['expired', new Date(Date.now() - Millis.minutes(1)).toISOString()],
	])('fails closed when an entitlement credential expiry is %s', async (_label, expiry) => {
		const groupEditor = createTestApi({
			bucket,
			userId: STRANGER,
			compute: makeFakeCompute(),
			deps: {
				authenticator: {
					authenticate: async () => ({
						credential: { kind: 'development' },
						id: STRANGER,
						email: `${STRANGER}@example.com`,
						entitlements: ['default-role:editor'],
						entitlementsExpiresAt: expiry,
					}),
				},
			},
		}).request;

		const error = await expectError(await groupEditor('POST', sessionsPath()), 403, 'FORBIDDEN');
		expect(error.message).toBe('Group authorization has expired; sign in again');
		expect(
			(await createServices(bucket).sessions.listSessions()).filter(
				(session) => session.user_id === STRANGER,
			),
		).toHaveLength(0);
	});

	it('destroys the sandbox when group authorization expires during provisioning', async () => {
		const now = Date.parse('2026-08-04T12:00:00.000Z');
		const deadline = now + Millis.minutes(1);
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
		const { instance, calls } = makeFakeSandbox();
		const exposePort = instance.exposePort.bind(instance);
		instance.exposePort = async (...args) => {
			const exposed = await exposePort(...args);
			nowSpy.mockReturnValue(deadline);
			return exposed;
		};
		const groupEditor = createTestApi({
			bucket,
			userId: STRANGER,
			compute: fakeComputeFrom(instance),
			deps: {
				authenticator: {
					authenticate: async () => ({
						credential: { kind: 'development' },
						id: STRANGER,
						email: `${STRANGER}@example.com`,
						entitlements: ['default-role:editor'],
						entitlementsExpiresAt: new Date(deadline).toISOString(),
					}),
				},
			},
		}).request;

		try {
			const error = await expectError(await groupEditor('POST', sessionsPath()), 403, 'FORBIDDEN');
			expect(error.message).toBe('Group authorization expired while starting the session');
			expect(calls.destroy).toBe(1);
			const [failed] = (await createServices(bucket).sessions.listSessions()).filter(
				(session) => session.user_id === STRANGER,
			);
			expect(failed).toMatchObject({
				status: 'failed',
				authorization_expires_at: new Date(deadline).toISOString(),
				error: {
					code: 'FORBIDDEN',
					message: 'Group authorization expired while starting the session',
				},
			});
		} finally {
			nowSpy.mockRestore();
		}
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
		expect(session.can).toEqual({
			attach: true,
			stop: true,
			surfaces: { vscode: true, opencode: true },
		});
		await expectOk(await god('POST', sessionsPath(`/${sid}/heartbeat`)));
		await expectOk(await god('DELETE', sessionsPath(`/${sid}`)));
	});

	it("a manager can stop another user's exclusive session without attaching", async () => {
		await createServices(bucket).projects.addMember(pid, { user_id: MANAGER }, 'manager', ACTOR);
		const ownerExclusive = exclusiveApi(ACTOR);
		const manager = exclusiveApi(MANAGER);
		const session = await expectOk<ApiSession>(await ownerExclusive('POST', sessionsPath()));

		const visible = await expectOk<ApiSession>(
			await manager('GET', sessionsPath(`/${session.session_id}`)),
		);
		expect(visible.can).toEqual({
			attach: false,
			stop: true,
			surfaces: { vscode: false, opencode: false },
		});
		await expectOk(await manager('DELETE', sessionsPath(`/${session.session_id}`)));
	});

	it('derives session capabilities from the PAT action grant', async () => {
		const sid = await startSession();
		const scoped = createTestApi({
			bucket,
			deps: {
				authenticator: {
					authenticate: async () => ({
						id: ACTOR,
						email: `${ACTOR}@example.com`,
						credential: {
							kind: 'personal-access-token',
							grant: {
								actions: ['project.read', 'session.attach'],
								projects: [pid],
							},
						},
					}),
				},
			},
		}).request;

		const session = await expectOk<ApiSession>(await scoped('GET', sessionsPath(`/${sid}`)));
		expect(session.can).toEqual({
			attach: true,
			stop: false,
			surfaces: { vscode: false, opencode: false },
		});
		await expectOk(await scoped('POST', sessionsPath(`/${sid}/heartbeat`)));
		await expectError(await scoped('DELETE', sessionsPath(`/${sid}`)), 403, 'FORBIDDEN');
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

		// A DIFFERENT notebook would be a second concurrent sandbox → rejected with 429.
		// (Re-POSTing the SAME notebook would RESUME, not be capped.)
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

		// The authoritative cap check runs after record creation but before provisioning,
		// and records the rejection for polling clients.
		expect(await createServices(bucket).sessions.listSessions(nid)).toHaveLength(1);
		const rejected = await createServices(bucket).sessions.listSessions(otherNb.id as NotebookId);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toMatchObject({
			status: 'failed',
			error: { code: 'RESOURCE_EXHAUSTED' },
		});
	});

	it('scans deployment-wide sessions once when enforcing the per-user cap', async () => {
		const services = createServices(bucket);
		const unrelatedProject = createProjectId();
		const unrelated = await services.sessions.createSession({
			project_id: unrelatedProject,
			notebook_id: createNotebookId(),
			user_id: STRANGER,
		});
		const listSpy = vi.spyOn(bucket, 'list');
		const getSpy = vi.spyOn(bucket, 'get');
		const capped = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			maxConcurrentSessionsPerUser: 5,
		}).request;

		await expectOk(await capped('POST', sessionsPath()));

		expect(
			listSpy.mock.calls.filter(([options]) => options?.prefix === paths.sessionsPrefix),
		).toHaveLength(1);
		expect(
			getSpy.mock.calls.filter(
				([key]) => key === paths.session(unrelatedProject, unrelated.session_id),
			),
		).toHaveLength(1);
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

	it('replaces a reusable session whose earlier group authorization has expired', async () => {
		const now = Date.now();
		let credentialDeadline = now + Millis.minutes(1);
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
		const { instance, calls } = makeFakeSandbox();
		const groupEditor = createTestApi({
			bucket,
			userId: STRANGER,
			compute: fakeComputeFrom(instance),
			deps: {
				authenticator: {
					authenticate: async () => ({
						credential: { kind: 'development' },
						id: STRANGER,
						email: `${STRANGER}@example.com`,
						entitlements: ['default-role:editor'],
						entitlementsExpiresAt: new Date(credentialDeadline).toISOString(),
					}),
				},
			},
		}).request;

		try {
			const first = await expectOk<ApiSession>(await groupEditor('POST', sessionsPath()));
			credentialDeadline = now + Millis.hours(2);
			nowSpy.mockReturnValue(now + Millis.minutes(1));

			const second = await expectOk<ApiSession>(await groupEditor('POST', sessionsPath()));

			expect(second.reused).toBe(false);
			expect(second.session_id).not.toBe(first.session_id);
			expect(calls.destroy).toBe(1);
			const sessions = await createServices(bucket).sessions.listSessions(nid);
			expect(sessions.find((session) => session.session_id === first.session_id)?.status).toBe(
				'terminated',
			);
			expect(
				sessions.find((session) => session.session_id === second.session_id)
					?.authorization_expires_at,
			).toBe(new Date(credentialDeadline).toISOString());
		} finally {
			nowSpy.mockRestore();
		}
	});

	it('reused sessions keep the earliest credential deadline', async () => {
		let credentialDeadline = new Date(Date.now() + Millis.hours(2)).toISOString();
		const groupEditor = createTestApi({
			bucket,
			userId: STRANGER,
			compute: makeFakeCompute(),
			deps: {
				authenticator: {
					authenticate: async () => ({
						credential: { kind: 'development' },
						id: STRANGER,
						email: `${STRANGER}@example.com`,
						entitlements: ['default-role:editor'],
						entitlementsExpiresAt: credentialDeadline,
					}),
				},
			},
		}).request;

		const first = await expectOk<ApiSession>(await groupEditor('POST', sessionsPath()));
		const shorter = new Date(Date.now() + Millis.minutes(30)).toISOString();
		credentialDeadline = shorter;
		const second = await expectOk<ApiSession>(await groupEditor('POST', sessionsPath()));

		expect(second.session_id).toBe(first.session_id);
		expect(second.reused).toBe(true);
		expect(
			(await createServices(bucket).sessions.getSession(pid, first.session_id))
				.authorization_expires_at,
		).toBe(shorter);

		credentialDeadline = new Date(Date.now() + Millis.hours(3)).toISOString();
		await expectOk<ApiSession>(await groupEditor('POST', sessionsPath()));
		expect(
			(await createServices(bucket).sessions.getSession(pid, first.session_id))
				.authorization_expires_at,
		).toBe(shorter);
	});

	it('an editor-claim race applies the attaching credential deadline to the winner', async () => {
		const winner = makeSession({
			project_id: pid,
			notebook_id: nid,
			user_id: ACTOR,
			status: 'running',
			sandbox_url: undefined,
		});
		await bucket.put(paths.session(pid, winner.session_id), JSON.stringify(winner));
		await bucket.put(
			paths.editorClaim(pid, nid),
			JSON.stringify({
				session_id: winner.session_id,
				sharing: 'shared',
				claimed_at: winner.started_at,
			}),
		);
		const deadline = new Date(Date.now() + Millis.minutes(15)).toISOString();
		const groupEditor = createTestApi({
			bucket,
			userId: STRANGER,
			compute: makeFakeCompute(),
			deps: {
				authenticator: {
					authenticate: async () => ({
						credential: { kind: 'development' },
						id: STRANGER,
						email: `${STRANGER}@example.com`,
						entitlements: ['default-role:editor'],
						entitlementsExpiresAt: deadline,
					}),
				},
			},
		}).request;

		const attached = await expectOk<ApiSession>(await groupEditor('POST', sessionsPath()));

		expect(attached.session_id).toBe(winner.session_id);
		expect(attached.reused).toBe(true);
		expect(
			(await createServices(bucket).sessions.getSession(pid, winner.session_id))
				.authorization_expires_at,
		).toBe(deadline);
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
		const deliver = vi.fn(async () => 'delivered' as const);
		const failOwner = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute({ failExec: 'true' }),
			deps: {
				projectAlerts: {
					store: {} as never,
					dispatcher: { deliver, test: vi.fn() },
					maxDestinations: 10,
				},
			},
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
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(deliver).not.toHaveBeenCalled();
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

	it('POST /sessions: Python setup failure is specific and stored on the session', async () => {
		const { instance: base, calls } = makeFakeSandbox();
		const instance: SandboxInstance = {
			...base,
			async exec(command) {
				if (!command.includes('uv sync')) return base.exec(command);
				calls.exec.push(command);
				return {
					success: false,
					stdout: '',
					stderr: 'failed to remove directory: Permission denied',
					error: { code: 'COMMAND_FAILED' },
				};
			},
		};
		const api = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(instance),
		}).request;

		const error = await expectError(
			await api('POST', sessionsPath()),
			503,
			'PYTHON_ENV_SETUP_FAILED',
		);
		expect(error.message).toContain('does not allow replacing');
		const all = await createServices(bucket).sessions.listSessions(nid);
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({
			status: 'failed',
			error: {
				code: 'PYTHON_ENV_SETUP_FAILED',
				message: expect.stringContaining('does not allow replacing'),
			},
		});
		expect(calls.startProcess).toHaveLength(0);
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
});
