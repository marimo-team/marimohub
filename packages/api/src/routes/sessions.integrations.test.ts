import { beforeEach, describe, expect, it } from 'vitest';
import {
	AesGcmSecretCodec,
	createServices,
	defaultRegistry,
	INTEGRATIONS_DIR,
	INTEGRATIONS_DIR_ENV,
	OrgIntegrationsStore,
	ProjectIntegrationsStore,
} from '@marimo-hub/core';
import type { NotebookId, ProjectId } from '@marimo-hub/core';
import { ACTOR, fakeComputeFrom, makeFakeSandbox, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const codec = new AesGcmSecretCodec({ kek: 'sBN3HR4/RHc81JkWZ794UoUuUnPEHvt7zvkBjjbTWk0=' });

describe('Session provisioning with integrations', () => {
	let bucket: MemoryBucket;
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
	});

	function api(
		store: ProjectIntegrationsStore,
		options: { userId?: ReturnType<typeof uid>; ephemeralViewer?: boolean } = {},
	) {
		const sandbox = makeFakeSandbox();
		const { request } = createTestApi({
			bucket,
			userId: options.userId ?? ACTOR,
			compute: fakeComputeFrom(sandbox.instance),
			deps: {
				integrations: store,
				...(options.ephemeralViewer
					? { policy: { defaultRole: 'viewer' as const, viewerMode: 'ephemeral-sandbox' as const } }
					: {}),
			},
		});
		return { request, calls: sandbox.calls };
	}

	function makeStore(withCodec = true) {
		return new ProjectIntegrationsStore({
			bucket,
			registry: defaultRegistry(),
			codec: withCodec ? codec : undefined,
		});
	}

	it('injects integration env + files into the sandbox and pins the audit trail', async () => {
		const store = makeStore();
		await store.create(
			pid,
			{
				kind: 'postgres',
				name: 'prod',
				config: { host: 'db.internal', database: 'db', username: 'u', password: 'pw' },
			},
			ACTOR,
		);
		const { request, calls } = api(store);
		const session = await expectOk<Record<string, unknown>>(
			await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`),
		);

		expect(session.integrations).toEqual([
			{ id: expect.stringMatching(/^intg-/), name: 'prod', kind: 'postgres', version: 1 },
		]);

		const env = Object.assign({}, ...calls.setEnvVars);
		expect(env.MARIMOHUB_PG_PROD_URL).toContain('db.internal');
		expect(env[INTEGRATIONS_DIR_ENV]).toBe(INTEGRATIONS_DIR);

		const written = calls.writeFile.map((f) => f.path);
		expect(written).toContain(`${INTEGRATIONS_DIR}/postgres/prod.json`);
		expect(written).toContain(`${INTEGRATIONS_DIR}/manifest.json`);

		// The integration layer merges UNDER the marimo-config layer; folding it in
		// must not drop that layer's fallback vars.
		expect(Object.assign({}, ...calls.setEnvDefaults)).toMatchObject({
			XDG_CACHE_HOME: '/tmp/marimohub-cache',
			XDG_STATE_HOME: '/tmp/marimohub-state',
		});
	});

	it('skips disabled integrations', async () => {
		const store = makeStore();
		const created = await store.create(
			pid,
			{ kind: 'custom_env', name: 'flags', config: { vars: { MY_FLAG: 'on' } } },
			ACTOR,
		);
		await store.update(pid, created.id, { enabled: false }, ACTOR);

		const { request, calls } = api(store);
		const session = await expectOk<Record<string, unknown>>(
			await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`),
		);
		expect(session.integrations).toBeUndefined();
		const env = Object.assign({}, ...calls.setEnvVars);
		expect(env.MY_FLAG).toBeUndefined();
	});

	it('does not inject integrations into a viewer ephemeral session', async () => {
		const store = makeStore();
		await store.create(
			pid,
			{ kind: 'custom_env', name: 'flags', config: { vars: { MY_FLAG: 'on' } } },
			ACTOR,
		);
		const { request, calls } = api(store, {
			userId: uid('user_ephemeral_integration_viewer'),
			ephemeralViewer: true,
		});
		const session = await expectOk<Record<string, unknown>>(
			await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`),
		);

		expect(session.ephemeral).toBe(true);
		expect(session.integrations).toBeUndefined();
		expect(Object.assign({}, ...calls.setEnvVars).MY_FLAG).toBeUndefined();
		expect(calls.writeFile.map((file) => file.path)).not.toContain(
			`${INTEGRATIONS_DIR}/manifest.json`,
		);
	});

	it('fails the session CLOSED when a configured integration cannot render', async () => {
		// Write with a codec, then render through a deployment that cannot decrypt it.
		await makeStore().create(
			pid,
			{
				kind: 'postgres',
				name: 'prod',
				config: { host: 'h', database: 'd', username: 'u', password: 'pw' },
			},
			ACTOR,
		);
		const { request, calls } = api(makeStore(false));
		await expectError(await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`), 422);
		expect(calls.setEnvVars).toHaveLength(0);
		expect(calls.writeFile).toHaveLength(0);
		expect(calls.startProcess).toHaveLength(0);
	});

	it('fails the session CLOSED when an INHERITED org integration cannot render', async () => {
		// The project has no integrations of its own — the broken config comes
		// entirely from the org tier, and its blast radius is every project.
		const org = new OrgIntegrationsStore({ bucket, registry: defaultRegistry(), codec });
		await org.create(
			{
				kind: 'postgres',
				name: 'warehouse',
				config: { host: 'h', database: 'd', username: 'u', password: 'pw' },
			},
			ACTOR,
		);
		const { request, calls } = api(makeStore(false));
		await expectError(await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`), 422);
		expect(calls.setEnvVars).toHaveLength(0);
		expect(calls.writeFile).toHaveLength(0);
		expect(calls.startProcess).toHaveLength(0);

		// The per-project escape hatch: a disabled same-name project instance
		// opts this project out of the broken org integration entirely.
		const projectStore = makeStore(false);
		const override = await projectStore.create(
			pid,
			{ kind: 'custom_env', name: 'warehouse', config: { vars: {} } },
			ACTOR,
		);
		await projectStore.update(pid, override.id, { enabled: false }, ACTOR);
		const optedOut = api(makeStore(false));
		const session = await expectOk<Record<string, unknown>>(
			await optedOut.request('POST', `/projects/${pid}/notebooks/${nid}/sessions`),
		);
		expect(session.integrations).toBeUndefined();
	});

	it('renders inherited org integrations into the session and pins them', async () => {
		const options = { bucket, registry: defaultRegistry(), codec };
		const org = new OrgIntegrationsStore(options);
		await org.create(
			{ kind: 'custom_env', name: 'org-flags', config: { vars: { ORG_FLAG: 'on' } } },
			ACTOR,
		);
		const store = makeStore();
		await store.create(
			pid,
			{ kind: 'custom_env', name: 'flags', config: { vars: { MY_FLAG: 'on' } } },
			ACTOR,
		);

		const { request, calls } = api(store);
		const session = await expectOk<Record<string, unknown>>(
			await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`),
		);
		expect(session.integrations).toEqual([
			{ id: expect.stringMatching(/^intg-/), name: 'flags', kind: 'custom_env', version: 1 },
			{ id: expect.stringMatching(/^intg-/), name: 'org-flags', kind: 'custom_env', version: 1 },
		]);
		const env = Object.assign({}, ...calls.setEnvVars);
		expect(env.ORG_FLAG).toBe('on');
		expect(env.MY_FLAG).toBe('on');
	});

	it('a same-name project integration overrides the inherited org config', async () => {
		const options = { bucket, registry: defaultRegistry(), codec };
		const org = new OrgIntegrationsStore(options);
		await org.create(
			{ kind: 'custom_env', name: 'flags', config: { vars: { SOURCE: 'org' } } },
			ACTOR,
		);
		const store = makeStore();
		await store.create(
			pid,
			{ kind: 'custom_env', name: 'flags', config: { vars: { SOURCE: 'project' } } },
			ACTOR,
		);

		const { request, calls } = api(store);
		const session = await expectOk<Record<string, unknown>>(
			await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`),
		);
		expect(session.integrations).toHaveLength(1);
		expect(Object.assign({}, ...calls.setEnvVars).SOURCE).toBe('project');
	});
});
