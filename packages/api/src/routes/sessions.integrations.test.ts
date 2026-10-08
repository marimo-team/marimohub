import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AesGcmSecretCodec,
	createServices,
	defaultRegistry,
	INTEGRATIONS_DIR,
	INTEGRATIONS_DIR_ENV,
	OrgIntegrationsStore,
	ProjectIntegrationsStore,
	projectSessionEnv,
} from '@marimo-hub/core';
import type { NotebookId, ProjectId } from '@marimo-hub/core';
import { ACTOR, fakeComputeFrom, makeFakeSandbox, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { mergeSessionEnv } from '../sandboxEnv';
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
		options: {
			userId?: ReturnType<typeof uid>;
			ephemeralViewer?: boolean;
			exclusiveEditor?: boolean;
		} = {},
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
					: options.exclusiveEditor
						? {
								policy: {
									defaultRole: 'editor' as const,
									editorSandboxSharing: 'exclusive' as const,
								},
							}
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

	async function customEnvApi(config: Record<string, unknown>) {
		const store = makeStore();
		await store.create(pid, { kind: 'custom_env', name: 'marimo-settings', config }, ACTOR);
		return api(store);
	}

	async function codeArtifactStore(method: 'static' | 'ambient' = 'static') {
		const resolve = vi.fn(async () => {
			throw new Error('private-aws-secret');
		});
		const store = new ProjectIntegrationsStore({
			bucket,
			registry: defaultRegistry(),
			codec,
			packageRegistryCredentials: { resolve },
			packageRegistryProbe: { fetch: vi.fn(), connect: vi.fn() },
		});
		await store.create(
			pid,
			{
				kind: 'aws_codeartifact',
				name: 'private',
				config: {
					domain: 'company',
					domain_owner: '123456789012',
					repository: 'python',
					auth:
						method === 'ambient'
							? { method }
							: { method, access_key_id: 'KEY', secret_access_key: 'private-aws-secret' },
				},
			},
			ACTOR,
		);
		return { store, resolve };
	}

	it.each([
		['token exchange', 'Package registry authentication failed.'],
		['WIF unavailable', 'CodeArtifact requires project AWS cloud access.'],
	] as const)(
		'stops session startup with a 503 when CodeArtifact fails: %s',
		async (failure, message) => {
			const { store, resolve } = await codeArtifactStore(
				failure === 'WIF unavailable' ? 'ambient' : 'static',
			);
			const { request, calls } = api(store);
			const error = await expectError(
				await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`),
				503,
			);
			expect(error.message).toBe(message);
			expect(JSON.stringify(error)).not.toContain('private-aws-secret');
			expect(calls.exec.some((command) => command.includes('uv sync'))).toBe(false);
			expect(calls.startProcess).toHaveLength(0);
			expect(resolve).toHaveBeenCalledTimes(failure === 'token exchange' ? 1 : 0);
		},
	);

	it('does not resolve CodeArtifact credentials for a restricted viewer', async () => {
		const { store, resolve } = await codeArtifactStore();
		const { request, calls } = api(store, {
			userId: uid('user_codeartifact_viewer'),
			ephemeralViewer: true,
		});
		await expectOk(await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`));
		expect(resolve).not.toHaveBeenCalled();
		expect(Object.assign({}, ...calls.setEnvVars).UV_INDEX_PRIVATE_PASSWORD).toBeUndefined();
	});

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

	it('applies project marimo settings as defaults the image and Hub can override', async () => {
		const { request, calls } = await customEnvApi({
			vars: { MARIMO_SQL_DEFAULT_LIMIT: '50', MY_FLAG: 'on' },
			secrets: [{ name: 'MARIMO_LENS_TOKEN', value: 'lens-token' }],
			secret_bundles: [
				{ name: 'MARIMO_SETTINGS', prefix: 'MARIMO_', value: '{"OUTPUT_MAX_BYTES":1000000}' },
			],
		});
		await expectOk(await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`));
		const forced = Object.assign({}, ...calls.setEnvVars);
		expect(forced).toMatchObject({ MY_FLAG: 'on', XDG_CONFIG_HOME: '/tmp/marimohub-config' });
		expect(Object.keys(forced).filter((name) => name.startsWith('MARIMO_'))).toEqual([]);
		expect(Object.assign({}, ...calls.setEnvDefaults)).toMatchObject({
			MARIMO_SQL_DEFAULT_LIMIT: '50',
			MARIMO_LENS_TOKEN: 'lens-token',
			MARIMO_OUTPUT_MAX_BYTES: '1000000',
		});
	});

	it('keeps a Hub-set marimo variable forced over the project default', () => {
		const env = mergeSessionEnv(projectSessionEnv({ vars: { MARIMO_OUTPUT_MAX_BYTES: '1' } }), {
			vars: { MARIMO_OUTPUT_MAX_BYTES: '2' },
		});
		expect(env.vars).toEqual({ MARIMO_OUTPUT_MAX_BYTES: '2' });
		expect(env.defaults).toEqual({ MARIMO_OUTPUT_MAX_BYTES: '1' });
	});

	it.each(['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', '_MARIMO_DISABLE_AUTH_ON_VIRTUAL_FILES'])(
		'rejects a project variable named %s',
		async (name) => {
			await expect(customEnvApi({ vars: { [name]: '/project' } })).rejects.toThrow(
				`Environment variable name "${name}" is reserved.`,
			);
		},
	);

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

	it('injects integrations into a temporary editor sandbox', async () => {
		const store = makeStore();
		await store.create(
			pid,
			{ kind: 'custom_env', name: 'flags', config: { vars: { MY_FLAG: 'on' } } },
			ACTOR,
		);

		const owner = api(store, { exclusiveEditor: true });
		await expectOk(await owner.request('POST', `/projects/${pid}/notebooks/${nid}/sessions`));

		const { request, calls } = api(store, {
			userId: uid('user_temporary_integration_editor'),
			exclusiveEditor: true,
		});
		const session = await expectOk<Record<string, unknown>>(
			await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`, {
				edit_intent: 'temporary',
			}),
		);

		expect(session.ephemeral).toBe(true);
		expect(session.integrations).toEqual([
			{ id: expect.stringMatching(/^intg-/), name: 'flags', kind: 'custom_env', version: 1 },
		]);
		expect(Object.assign({}, ...calls.setEnvVars).MY_FLAG).toBe('on');
		expect(calls.writeFile.map((file) => file.path)).toContain(`${INTEGRATIONS_DIR}/manifest.json`);
	});

	it.each([
		['MARIMO', 'HUB_SETTING'],
		['MARIMO_', 'VERSION'],
		['_MARIMO_', 'DISABLE_AUTH_ON_VIRTUAL_FILES'],
		['XDG_', 'CONFIG_HOME'],
		['MARIMO_', 'INVALID-NAME'],
	])('rejects session creation when a secret bundle expands to %s%s', async (prefix, key) => {
		const { request, calls } = await customEnvApi({
			vars: { MARIMO_OUTPUT_MAX_BYTES: '1' },
			secret_bundles: [
				{ name: 'SETTINGS', prefix, value: JSON.stringify({ [key]: 'private-value' }) },
			],
		});
		const error = await expectError(
			await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`),
			422,
		);
		expect(error.message).toBe('Integration "marimo-settings" could not be rendered.');
		expect(calls.setEnvVars).toHaveLength(0);
		expect(calls.startProcess).toHaveLength(0);
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
