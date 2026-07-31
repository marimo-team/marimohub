import { describe, it, expect, beforeEach } from 'vitest';
import { createServices, paths } from '@marimo-hub/core';
import type { NotebookId, ProjectId } from '@marimo-hub/core';
import {
	ACTOR,
	appClaimHolder,
	fakeComputeFrom,
	makeFakeCompute,
	makeFakeSandbox,
	makeSession,
	uid,
} from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const OTHER_EDITOR = uid('user_other');

const enc = (s: string) => new TextEncoder().encode(s);

describe('Session routes (app mode)', () => {
	let bucket: MemoryBucket;
	let owner: ReturnType<typeof createTestApi>['request'];
	let pid: ProjectId;
	let nid: NotebookId;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		pid = project.id as ProjectId;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		nid = notebook.id as NotebookId;
		owner = createTestApi({ bucket, userId: ACTOR, compute: makeFakeCompute() }).request;
	});

	const sessionsPath = (suffix = '', notebookId: NotebookId = nid) =>
		`/projects/${pid}/notebooks/${notebookId}/sessions${suffix}`;

	it('starts an app alongside an edit session; stopping one leaves the other', async () => {
		const edit = await expectOk<any>(await owner('POST', sessionsPath()));
		const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));

		expect(edit.mode).toBe('edit');
		expect(app.mode).toBe('app');
		expect(app.session_id).not.toBe(edit.session_id);
		expect(app.status).toBe('running');

		await expectOk(await owner('DELETE', sessionsPath(`/${app.session_id}`)));
		const remaining = await expectOk<any>(await owner('GET', sessionsPath(`/${edit.session_id}`)));
		expect(remaining.status).toBe('running');
	});

	it('stamps source_version_id from the notebook head at create', async () => {
		const services = createServices(bucket);
		const { source } = await services.notebooks.getNotebook(pid, nid);
		const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
		expect(app.source_version_id).toBe(source.current_version_id);

		// A later version cut does not mutate the running session's provenance.
		await services.notebooks.commitSession(pid, nid, { code: 'import marimo  # changed' }, ACTOR);
		const same = await expectOk<any>(await owner('GET', sessionsPath(`/${app.session_id}`)));
		expect(same.source_version_id).toBe(source.current_version_id);
	});

	it('writes the app claim at create and releases it on delete', async () => {
		const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
		expect(await appClaimHolder(bucket, pid, nid)).toBe(app.session_id);

		await expectOk(await owner('DELETE', sessionsPath(`/${app.session_id}`)));
		expect(await appClaimHolder(bucket, pid, nid)).toBeNull();
	});

	it('repeat app create reuses; a different editor attaches to the same app', async () => {
		const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));

		const again = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
		expect(again.session_id).toBe(app.session_id);
		expect(again.reused).toBe(true);

		const other = createTestApi({
			bucket,
			userId: OTHER_EDITOR,
			compute: makeFakeCompute(),
			deps: { policy: { defaultRole: 'editor' } },
		}).request;
		const attached = await expectOk<any>(await other('POST', sessionsPath(), { mode: 'app' }));
		expect(attached.session_id).toBe(app.session_id);
		expect(attached.reused).toBe(true);
		// Attribution stays with the starter.
		expect(attached.user_id).toBe(ACTOR);
	});

	it('a create that loses the app claim attaches to the claim holder', async () => {
		// The holder is live for claim purposes (running) but invisible to reuse
		// (no sandbox_url) — the shape a true concurrent-start race produces.
		const winner = makeSession({
			project_id: pid,
			notebook_id: nid,
			user_id: OTHER_EDITOR,
			status: 'running',
			mode: 'app',
			sandbox_url: undefined,
		});
		await bucket.put(paths.session(pid, winner.session_id), JSON.stringify(winner));
		await bucket.put(
			paths.appClaim(pid, nid),
			JSON.stringify({ session_id: winner.session_id, claimed_at: winner.started_at }),
		);

		const attached = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
		expect(attached.session_id).toBe(winner.session_id);
		expect(attached.reused).toBe(true);

		// The loser's own record was retired, and no second app is left active.
		const services = createServices(bucket);
		expect(await services.sessions.countActiveAppsForProject(pid)).toBe(1);
	});

	it('a claim stolen mid-provision destroys the loser sandbox and attaches to the thief', async () => {
		// A slow provision looks like a wedged holder to a second "Run as app",
		// which CAS-replaces the claim. Simulated by swapping the claim (and
		// seeding the thief's running record) inside the provision phase — after
		// the saga's app_claim step, before its post-provision recheck.
		const thief = makeSession({
			project_id: pid,
			notebook_id: nid,
			user_id: OTHER_EDITOR,
			status: 'running',
			mode: 'app',
			sandbox_url: undefined,
		});
		const fake = makeFakeSandbox();
		let stolen = false;
		const instance = {
			...fake.instance,
			startProcess: (async (...args: Parameters<typeof fake.instance.startProcess>) => {
				if (!stolen) {
					stolen = true;
					await bucket.put(paths.session(pid, thief.session_id), JSON.stringify(thief));
					await bucket.put(
						paths.appClaim(pid, nid),
						JSON.stringify({ session_id: thief.session_id, claimed_at: thief.started_at }),
					);
				}
				return fake.instance.startProcess(...args);
			}) as typeof fake.instance.startProcess,
		};
		const api = createTestApi({ bucket, userId: ACTOR, compute: fakeComputeFrom(instance) });

		const res = await expectOk<any>(await api.request('POST', sessionsPath(), { mode: 'app' }));
		expect(res.session_id).toBe(thief.session_id);
		expect(res.reused).toBe(true);

		// The loser's sandbox was destroyed (saga compensation) and its record
		// retired — the thief's app is the only active one, still holding the claim.
		expect(fake.calls.destroy).toBe(1);
		const services = createServices(bucket);
		expect(await services.sessions.countActiveAppsForProject(pid)).toBe(1);
		const claim = await bucket.get(paths.appClaim(pid, nid));
		expect(await claim!.json()).toMatchObject({ session_id: thief.session_id });
	});

	it('an app session never mounts the bucket and launches marimo run', async () => {
		const fake = makeFakeSandbox();
		const api = createTestApi({ bucket, userId: ACTOR, compute: fakeComputeFrom(fake.instance) });
		await expectOk<any>(await api.request('POST', sessionsPath(), { mode: 'app' }));

		expect(fake.calls.mountBucket).toHaveLength(0);
		expect(fake.calls.startProcess[0].cmd).toContain('marimo run');
		expect(fake.calls.startProcess[0].cmd).not.toContain('--convert');
	});

	it('merges managed AI into edit config but injects no config into an app session', async () => {
		const ai = {
			upstreamBaseUrl: 'https://ai.example',
			upstreamApiKey: 'k',
			model: 'gpt-test',
			signingSecret: 's'.repeat(32),
		};
		const editFake = makeFakeSandbox();
		const editApi = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(editFake.instance),
			deps: { ai },
		});
		await expectOk<any>(await editApi.request('POST', sessionsPath()));
		const editConfig = editFake.calls.writeFiles
			.flat()
			.find((file) => file.path === '/tmp/marimohub-config/marimo/marimo.toml');
		expect(editConfig?.content).toContain('default_width = "medium"');
		expect(editConfig?.content).toContain('default_sql_output = "native"');
		expect(editConfig?.content).toContain('[ai]');
		expect(editConfig?.content).toContain('[ai.custom_providers.marimohub]');

		const runFake = makeFakeSandbox();
		const runApi = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(runFake.instance),
			deps: { ai },
		});
		await expectOk<any>(await runApi.request('POST', sessionsPath(), { mode: 'app' }));
		expect(
			runFake.calls.writeFiles.flat().some((file) => file.path.endsWith('/marimo/marimo.toml')),
		).toBe(false);
		expect(runFake.calls.setEnvVars.flatMap(Object.keys)).not.toContain('XDG_CONFIG_HOME');
		expect(runFake.calls.setEnvDefaults).toHaveLength(0);
	});

	describe('viewer admission per MARIMOHUB_VIEWER_MODE', () => {
		const viewerApi = (viewerMode?: 'static' | 'applications' | 'ephemeral-sandbox') =>
			createTestApi({
				bucket,
				userId: uid('user_viewer'),
				compute: makeFakeCompute(),
				deps: { policy: { defaultRole: 'viewer', ...(viewerMode ? { viewerMode } : {}) } },
			}).request;

		it('rejects a viewer’s app request under `static` (and when unset)', async () => {
			await expectError(await viewerApi('static')('POST', sessionsPath(), { mode: 'app' }), 403);
			await expectError(await viewerApi()('POST', sessionsPath(), { mode: 'app' }), 403);
		});

		it('admits a viewer’s app under `applications` and `ephemeral-sandbox` — as the shared singleton, never ephemeral', async () => {
			for (const viewerMode of ['applications', 'ephemeral-sandbox'] as const) {
				const app = await expectOk<any>(
					await viewerApi(viewerMode)('POST', sessionsPath(), { mode: 'app' }),
				);
				expect(app.mode).toBe('app');
				expect(app.status).toBe('running');
				expect(app.ephemeral).toBeFalsy();
				await expectOk(await owner('DELETE', sessionsPath(`/${app.session_id}`)));
			}
		});

		it('`applications` grants apps only — a viewer’s edit request is still rejected', async () => {
			await expectError(await viewerApi('applications')('POST', sessionsPath()), 403);
			await expectError(
				await viewerApi('applications')('POST', sessionsPath(), { mode: 'edit' }),
				403,
			);
		});

		it('a viewer attaches to the app an editor started, with viewer-shaped grants', async () => {
			const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
			expect(app.can).toEqual({ attach: true, stop: true });

			const attached = await expectOk<any>(
				await viewerApi('applications')('POST', sessionsPath(), { mode: 'app' }),
			);
			expect(attached.session_id).toBe(app.session_id);
			expect(attached.reused).toBe(true);
			// The response carries the CALLER's evaluated grants, not the starter's.
			expect(attached.can).toEqual({ attach: true, stop: false });
		});

		it('a viewer may heartbeat the shared app under `applications`, not under `static`', async () => {
			const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
			const beat = sessionsPath(`/${app.session_id}/heartbeat`);
			await expectOk(await viewerApi('applications')('POST', beat));
			await expectError(await viewerApi('static')('POST', beat), 403, 'FORBIDDEN');
		});

		it('a viewer can never stop the shared app', async () => {
			const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
			await expectError(
				await viewerApi('applications')('DELETE', sessionsPath(`/${app.session_id}`)),
				403,
				'FORBIDDEN',
			);
			await expectError(
				await viewerApi('ephemeral-sandbox')('DELETE', sessionsPath(`/${app.session_id}`)),
				403,
				'FORBIDDEN',
			);
		});

		it('read projections withhold the kernel URL from callers the kernel gates would reject', async () => {
			// In subdomain exposure the URL IS the kernel capability (`--no-token`),
			// so list/get must not hand it to a viewer who couldn't reach the kernel.
			const edit = await expectOk<any>(await owner('POST', sessionsPath()));
			const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));

			const urlsFor = async (request: ReturnType<typeof createTestApi>['request']) => {
				const page = await expectOk<any>(await request('GET', `/projects/${pid}/sessions`));
				return new Map<string, string | undefined>(
					page.items.map((s: any) => [s.session_id, s.sandbox_url]),
				);
			};

			const staticUrls = await urlsFor(viewerApi('static'));
			expect(staticUrls.get(app.session_id)).toBeUndefined();
			expect(staticUrls.get(edit.session_id)).toBeUndefined();

			const appsUrls = await urlsFor(viewerApi('applications'));
			expect(appsUrls.get(app.session_id)).toBeTruthy();
			expect(appsUrls.get(edit.session_id)).toBeUndefined();

			const editorUrls = await urlsFor(owner);
			expect(editorUrls.get(app.session_id)).toBeTruthy();
			expect(editorUrls.get(edit.session_id)).toBeTruthy();

			// getSession mirrors the list projection.
			const denied = await expectOk<any>(
				await viewerApi('static')('GET', sessionsPath(`/${app.session_id}`)),
			);
			expect(denied.sandbox_url).toBeUndefined();
			const granted = await expectOk<any>(
				await viewerApi('applications')('GET', sessionsPath(`/${app.session_id}`)),
			);
			expect(granted.sandbox_url).toBeTruthy();
		});

		it('a viewer still sees the URL of their OWN ephemeral session in the list', async () => {
			const viewer = viewerApi('ephemeral-sandbox');
			const own = await expectOk<any>(await viewer('POST', sessionsPath()));
			const page = await expectOk<any>(await viewer('GET', `/projects/${pid}/sessions`));
			const item = page.items.find((s: any) => s.session_id === own.session_id);
			expect(item.sandbox_url).toBeTruthy();
		});

		it('members-only deployment: membership, not the viewer mode alone, grants app access', async () => {
			// No default role: `applications` must not open apps to arbitrary
			// authenticated users — only to those who hold at least viewer.
			const outsider = createTestApi({
				bucket,
				userId: uid('user_outsider'),
				compute: makeFakeCompute(),
				deps: { policy: { viewerMode: 'applications' } },
			}).request;
			await expectError(await outsider('POST', sessionsPath(), { mode: 'app' }), 403, 'FORBIDDEN');

			const memberId = uid('user_member_viewer');
			await createServices(bucket).projects.addMember(pid, { user_id: memberId }, 'viewer', ACTOR);
			const member = createTestApi({
				bucket,
				userId: memberId,
				compute: makeFakeCompute(),
				deps: { policy: { viewerMode: 'applications' } },
			}).request;
			const app = await expectOk<any>(await member('POST', sessionsPath(), { mode: 'app' }));
			expect(app.mode).toBe('app');
			expect(app.ephemeral).toBeFalsy();
		});

		it('a viewer may not heartbeat another user’s EDIT session in any viewer mode', async () => {
			const edit = await expectOk<any>(await owner('POST', sessionsPath()));
			const beat = sessionsPath(`/${edit.session_id}/heartbeat`);
			for (const viewerMode of ['static', 'applications', 'ephemeral-sandbox'] as const) {
				await expectError(await viewerApi(viewerMode)('POST', beat), 403, 'FORBIDDEN');
			}
		});
	});

	it('rejects an unknown mode with a validation error', async () => {
		await expectError(await owner('POST', sessionsPath(), { mode: 'serve' }), 422);
	});

	it('the per-user cap ignores app sessions (edit + app coexist at cap 1)', async () => {
		const capped = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			maxConcurrentSessionsPerUser: 1,
		}).request;
		await expectOk<any>(await capped('POST', sessionsPath()));
		const app = await expectOk<any>(await capped('POST', sessionsPath(), { mode: 'app' }));
		expect(app.mode).toBe('app');
		// The cap still applies to a second EDIT notebook.
		const services = createServices(bucket);
		const nb2 = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB2', description: 'd', code: 'import marimo' },
			ACTOR,
		);
		await expectError(
			await capped('POST', sessionsPath('', nb2.id as NotebookId)),
			429,
			'RESOURCE_EXHAUSTED',
		);
	});

	it('the per-user cap bounds the apps a user has STARTED across projects', async () => {
		// Fanning apps out over freely creatable projects must not escape the
		// per-user cost ceiling.
		const services = createServices(bucket);
		const p2 = await services.projects.createProject({ name: 'P2', description: 'd' }, ACTOR);
		const nb2 = await services.notebooks.createNotebook(
			p2.id as ProjectId,
			{ title: 'NB2', description: 'd', code: 'import marimo' },
			ACTOR,
		);
		const capped = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			maxConcurrentSessionsPerUser: 1,
		}).request;

		const app = await expectOk<any>(await capped('POST', sessionsPath(), { mode: 'app' }));
		// Attaching to the app the user already started is a reuse, not a new start.
		const attach = await expectOk<any>(await capped('POST', sessionsPath(), { mode: 'app' }));
		expect(attach.session_id).toBe(app.session_id);
		await expectError(
			await capped('POST', `/projects/${p2.id}/notebooks/${nb2.id}/sessions`, { mode: 'app' }),
			429,
			'RESOURCE_EXHAUSTED',
		);
	});

	it('an empty JSON body still gets the error envelope', async () => {
		const api = createTestApi({ bucket, userId: ACTOR, compute: makeFakeCompute() });
		const res = await api.app.request(`/api/v1${sessionsPath()}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '',
		});
		await expectError(res, 400, 'BAD_REQUEST');
	});

	it('deleting the notebook drops the app claim (no permanently-orphaned pointer)', async () => {
		await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
		expect(await bucket.get(paths.appClaim(pid, nid))).not.toBeNull();

		await expectOk(await owner('DELETE', `/projects/${pid}/notebooks/${nid}`));
		expect(await bucket.get(paths.appClaim(pid, nid))).toBeNull();
	});

	it('deleting the notebook retires its running app', async () => {
		const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
		await expectOk(await owner('DELETE', `/projects/${pid}/notebooks/${nid}`));
		const services = createServices(bucket);
		expect(await services.sessions.countActiveAppsForProject(pid)).toBe(0);
		const record = await services.sessions.getSession(pid, app.session_id);
		expect(record.status).toBe('terminated');
	});

	it('rejects session create on a soft-deleted notebook — the app claim is not re-leaked', async () => {
		await expectOk(await owner('DELETE', `/projects/${pid}/notebooks/${nid}`));
		await expectError(await owner('POST', sessionsPath()), 404, 'NOT_FOUND');
		await expectError(await owner('POST', sessionsPath(), { mode: 'app' }), 404, 'NOT_FOUND');
		expect(await bucket.get(paths.appClaim(pid, nid))).toBeNull();
	});

	describe('dead-kernel retire on the shared app', () => {
		it('never runs for a caller who could not stop the app (viewer)', async () => {
			const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
			const viewer = createTestApi({
				bucket,
				userId: uid('user_viewer'),
				compute: makeFakeCompute(),
				deps: {
					policy: { defaultRole: 'viewer', viewerMode: 'applications' },
					kernelProbe: async () => 'dead' as const,
				},
			}).request;

			const attached = await expectOk<any>(await viewer('POST', sessionsPath(), { mode: 'app' }));
			expect(attached.session_id).toBe(app.session_id);
			expect(attached.reused).toBe(true);
			// The shared app was not torn down under everyone else.
			const still = await expectOk<any>(await owner('GET', sessionsPath(`/${app.session_id}`)));
			expect(still.status).toBe('running');
		});

		it('still replaces the dead app for a caller who may stop it (editor)', async () => {
			const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
			const editor = createTestApi({
				bucket,
				userId: OTHER_EDITOR,
				compute: makeFakeCompute(),
				deps: {
					policy: { defaultRole: 'editor' },
					kernelProbe: async () => 'dead' as const,
				},
			}).request;

			const fresh = await expectOk<any>(await editor('POST', sessionsPath(), { mode: 'app' }));
			expect(fresh.session_id).not.toBe(app.session_id);
			expect(fresh.reused).toBe(false);
			expect(fresh.status).toBe('running');
		});
	});

	it('records an audit event for the app start; an attach records nothing', async () => {
		const utcDay = () => new Date().toISOString().slice(0, 10);
		// `append` keys events by its own clock, and `getEvents` reads one day's
		// prefix — so a UTC-midnight rollover mid-test would hide them.
		const startedOn = utcDay();
		const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
		await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));

		const services = createServices(bucket);
		const days = [...new Set([startedOn, utcDay()])];
		const events = (await Promise.all(days.map((d) => services.events.getEvents(d)))).flat();
		const starts = events.filter((e) => e.event === 'app.start');
		expect(starts).toHaveLength(1);
		expect(starts[0]).toMatchObject({ actor: ACTOR, session_id: app.session_id });
	});

	it('withholds the failure reason from callers who may not reach the kernel', async () => {
		// A provision error can name the sandbox host — the very thing the
		// sandbox_url withholding protects — so it rides the same grant.
		const failed = makeSession({
			project_id: pid,
			notebook_id: nid,
			status: 'failed',
			mode: 'app',
			error: { code: 'PROVISION_FAILED', message: 'sandbox-abc.internal unreachable' },
		});
		await bucket.put(paths.session(pid, failed.session_id), JSON.stringify(failed));

		const mine = await expectOk<any>(await owner('GET', sessionsPath(`/${failed.session_id}`)));
		expect(mine.error?.code).toBe('PROVISION_FAILED');

		const viewer = createTestApi({
			bucket,
			userId: uid('user_viewer'),
			deps: { policy: { defaultRole: 'viewer' } },
		}).request;
		const theirs = await expectOk<any>(await viewer('GET', sessionsPath(`/${failed.session_id}`)));
		expect(theirs.error).toBeUndefined();
	});

	it('delete/heartbeat 404 (never 403) when the project is hidden from the caller', async () => {
		// Members-only deployment: a 403 would confirm the session id exists in a
		// project the caller cannot even see; getSession already answers 404.
		const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
		const outsider = createTestApi({ bucket, userId: uid('user_outsider') }).request;
		await expectError(
			await outsider('DELETE', sessionsPath(`/${app.session_id}`)),
			404,
			'NOT_FOUND',
		);
		await expectError(
			await outsider('POST', sessionsPath(`/${app.session_id}/heartbeat`)),
			404,
			'NOT_FOUND',
		);
	});

	it('caps concurrent apps per project (attach never trips it)', async () => {
		const services = createServices(bucket);
		const nb2 = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB2', description: 'd', code: 'import marimo' },
			ACTOR,
		);
		const capped = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			deps: { policy: { maxAppsPerProject: 1 } },
		}).request;

		const app = await expectOk<any>(await capped('POST', sessionsPath(), { mode: 'app' }));
		// Attaching to the running app is a reuse, never a cap rejection.
		const attach = await expectOk<any>(await capped('POST', sessionsPath(), { mode: 'app' }));
		expect(attach.session_id).toBe(app.session_id);
		// A second notebook's app exceeds the project cap.
		await expectError(
			await capped('POST', sessionsPath('', nb2.id as NotebookId), { mode: 'app' }),
			429,
			'RESOURCE_EXHAUSTED',
		);
	});

	it('deleting an app session cuts no version', async () => {
		const services = createServices(bucket);
		const before = await services.notebooks.listVersions(pid, nid);
		const app = await expectOk<any>(await owner('POST', sessionsPath(), { mode: 'app' }));
		await expectOk(await owner('DELETE', sessionsPath(`/${app.session_id}`)));
		const after = await services.notebooks.listVersions(pid, nid);
		expect(after.length).toBe(before.length);
	});

	it('projects a legacy record without mode as edit', async () => {
		const services = createServices(bucket);
		const legacy = await services.sessions.createSession({
			notebook_id: nid,
			project_id: pid,
			user_id: ACTOR,
		});
		const got = await expectOk<any>(await owner('GET', sessionsPath(`/${legacy.session_id}`)));
		expect(got.mode).toBe('edit');
	});

	it('starts an app for a git-synced notebook from its synced version', async () => {
		const services = createServices(bucket);
		const { meta } = await services.notebooks.synced.create(
			pid,
			{
				title: 'Git NB',
				description: 'd',
				repo: 'owner/repo',
				branch: 'main',
				entry_notebook: 'app.py',
			},
			ACTOR,
		);
		await services.notebooks.synced.sync(pid, meta.id as NotebookId, {
			repo: 'owner/repo',
			branch: 'main',
			root_path: '',
			commit: 'commit-aaaa',
			files: [{ path: 'app.py', bytes: enc('import marimo') }],
		});

		const app = await expectOk<any>(
			await owner('POST', sessionsPath('', meta.id as NotebookId), { mode: 'app' }),
		);
		expect(app.mode).toBe('app');
		expect(app.status).toBe('running');
		const { source } = await services.notebooks.getNotebook(pid, meta.id as NotebookId);
		expect(app.source_version_id).toBe(source.current_version_id);
	});
});
