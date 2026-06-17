import { describe, it, expect, beforeEach } from 'vitest';
import {
	createNotebookId,
	createProjectId,
	createServices,
	type NotebookId,
	type ProjectId,
} from '@marimo-hub/core';
import { ACTOR, makeFakeCompute, type MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const STRANGER = 'user_stranger';

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

	async function startSession(): Promise<string> {
		const data = await expectOk<any>(await owner('POST', sessionsPath()));
		return data.session_id as string;
	}

	it('POST /sessions as the owner (editor) creates a running session', async () => {
		const data = await expectOk<any>(await owner('POST', sessionsPath()));
		expect(data.session_id).toMatch(/^sess-/);
		expect(data.status).toBe('running');
		expect(data.project_id).toBe(pid);
		expect(data.notebook_id).toBe(nid);
	});

	it('POST /sessions as a non-member returns 403', async () => {
		await expectError(await stranger('POST', sessionsPath()), 403, 'FORBIDDEN');
	});

	it('DELETE /sessions/{sid} as a non-member returns 403 (IDOR fix)', async () => {
		const sid = await startSession();
		await expectError(await stranger('DELETE', sessionsPath(`/${sid}`)), 403, 'FORBIDDEN');

		// The session must still be terminable by the owner — the 403 did not act.
		await expectOk(await owner('DELETE', sessionsPath(`/${sid}`)));
	});

	it('DELETE /sessions/{sid} for a session in a different notebook/project returns 404 (scoping fix)', async () => {
		// A session that lives under a DIFFERENT project/notebook than the URL path.
		const otherServices = createServices(bucket);
		const foreign = await otherServices.sessions.createSession({
			notebook_id: createNotebookId(),
			project_id: createProjectId(),
			user_id: ACTOR,
		});

		// Owner of the path's project asks to delete it via the path's pid/nid.
		await expectError(
			await owner('DELETE', sessionsPath(`/${foreign.session_id}`)),
			404,
			'NOT_FOUND',
		);

		// The cross-scope session was NOT terminated (still loadable as starting).
		const stillThere = await otherServices.sessions.getSession(foreign.session_id);
		expect(stillThere.status).toBe('starting');
	});

	it('POST /sessions/{sid}/heartbeat as a non-member returns 403', async () => {
		const sid = await startSession();
		await expectError(await stranger('POST', sessionsPath(`/${sid}/heartbeat`)), 403, 'FORBIDDEN');
	});

	it('POST /sessions/{sid}/heartbeat happy path as the owner returns 200', async () => {
		const sid = await startSession();
		const data = await expectOk<any>(await owner('POST', sessionsPath(`/${sid}/heartbeat`)));
		expect(data.session_id).toBe(sid);
		expect(data.status).toBe('running');
	});

	it('DELETE /sessions/{sid} happy path as the owner returns 200', async () => {
		const sid = await startSession();
		await expectOk(await owner('DELETE', sessionsPath(`/${sid}`)));
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

		// Second is rejected with 429 before provisioning a second sandbox.
		await expectError(await capped('POST', sessionsPath()), 429, 'RESOURCE_EXHAUSTED');

		// Only one session record exists for the notebook.
		const all = await createServices(bucket).sessions.listSessions(nid);
		expect(all).toHaveLength(1);
	});

	it('POST /sessions: when provisioning fails, responds with an error and terminates the session', async () => {
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

		// The session that was created before provisioning must end up terminated,
		// not stuck in `starting`. Assert via the service over the shared bucket.
		const all = await createServices(bucket).sessions.listSessions(nid);
		expect(all).toHaveLength(1);
		expect(all[0].status).toBe('terminated');
	});
});
