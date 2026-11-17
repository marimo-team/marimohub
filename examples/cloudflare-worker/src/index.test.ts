import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

vi.mock('@marimo-hub/compute-cloudflare', () => ({
	CloudflareSandboxProvider: class CloudflareSandboxProvider {
		constructor(
			readonly binding: unknown,
			readonly options: unknown,
		) {}
		async proxy() {
			return null;
		}
	},
	ContainerProxy: class ContainerProxy {},
	Sandbox: class Sandbox {},
}));

vi.mock('@marimo-hub/storage-r2', () => ({
	R2BucketAdapter: vi.fn(function R2BucketAdapter(binding: object) {
		// Each adapter has its own cache identity, even when the backing storage is shared.
		return new Proxy(binding, {
			get(target, key) {
				const value = Reflect.get(target, key);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}),
}));

import {
	createServices,
	MaintenanceLock,
	MigrationService,
	SessionService,
	SessionRetirer,
	paths,
} from '@marimo-hub/core';
import { ASSIGNABLE_ROLES } from '@marimo-hub/core/constants';
import type { AssignableRole } from '@marimo-hub/core/constants';
import { JobScheduler } from '@marimo-hub/core/jobs';
import { ACTOR } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { R2BucketAdapter } from '@marimo-hub/storage-r2';
import worker, { buildDeps } from './index';

const makeEnv = (bucket = new MemoryBucket()): Env => ({
	AUTH_MODE: 'dev',
	USER_ID: ACTOR,
	USER_EMAIL: `${ACTOR}@example.com`,
	NOTEBOOKS_BUCKET: bucket as never,
	SANDBOX: {} as never,
});
const makeContext = (waitUntil = vi.fn()): ExecutionContext => ({
	waitUntil,
	passThroughOnException() {},
	props: {},
});

function fetchApi(env: Env, path = '/api/v1/capabilities', ctx = makeContext()) {
	return worker.fetch(new Request(new URL(path, 'https://hub.example.com')), env, ctx);
}

afterEach(() => {
	vi.restoreAllMocks();
});

it('registers core audits with waitUntil while awaiting session teardown', async () => {
	const tasks: Promise<unknown>[] = [];
	const bucket = new MemoryBucket();
	const env = makeEnv(bucket);
	const ctx = makeContext(
		vi.fn((task: Promise<unknown>) => {
			tasks.push(task);
		}),
	);
	const deps = buildDeps(new Request('https://hub.example.com'), env);
	expect(deps.teardownInline).toBe(true);
	await deps.services.catalog.initialize(ACTOR);
	const project = await deps.services.projects.createProject({ name: 'P', description: '' }, ACTOR);
	const notebook = await deps.services.notebooks.createNotebook(
		project.id,
		{ title: 'N', description: '', code: '' },
		ACTOR,
	);
	const updated = await worker.fetch(
		new Request(`https://hub.example.com/api/v1/projects/${project.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Updated project' }),
		}),
		env,
		ctx,
	);
	expect(updated.status).toBe(200);
	await Promise.all(tasks);
	expect(tasks.length).toBeGreaterThan(0);
	const session = await deps.services.sessions.createSession({
		project_id: project.id,
		notebook_id: notebook.id,
		user_id: ACTOR,
		mode: 'edit',
	});
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const original = SessionRetirer.prototype.stop;
	vi.spyOn(SessionRetirer.prototype, 'stop').mockImplementation(
		async function (this: SessionRetirer, value, options) {
			entered.resolve();
			await gate.promise;
			return original.call(this, value, options);
		},
	);
	let responded = false;
	const response = Promise.resolve(
		worker.fetch(
			new Request(
				`https://hub.example.com/api/v1/projects/${project.id}/notebooks/${notebook.id}/sessions/${session.session_id}`,
				{ method: 'DELETE' },
			),
			env,
			ctx,
		),
	).then((res) => {
		responded = true;
		return res;
	});
	await entered.promise;
	expect(responded).toBe(false);
	expect((await deps.services.sessions.getSession(project.id, session.session_id)).status).toBe(
		'terminating',
	);
	gate.resolve();
	expect((await response).status).toBe(202);
	expect((await deps.services.sessions.getSession(project.id, session.session_id)).status).toBe(
		'terminated',
	);
});

describe('Cloudflare Worker isolate reuse', () => {
	it('reads one snapshot across two requests and still observes catalog updates', async () => {
		const bucket = new MemoryBucket();
		const writer = createServices(bucket);
		await writer.catalog.initialize(ACTOR);
		const get = vi.spyOn(bucket, 'get');
		const env = makeEnv(bucket);
		const adapters = vi.mocked(R2BucketAdapter).mock.calls.length;
		const request = () => fetchApi(env, '/api/v1/projects');

		for (let i = 0; i < 2; i++) {
			const response = await request();
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				success: true,
				data: { items: [expect.objectContaining({ name: 'My Project' })] },
			});
		}
		expect(get.mock.calls.filter(([key]) => key.startsWith(paths.snapshotsPrefix))).toHaveLength(1);
		expect(vi.mocked(R2BucketAdapter).mock.calls.length - adapters).toBe(1);

		const project = await writer.projects.createProject(
			{ name: 'New project', description: '' },
			ACTOR,
		);
		get.mockClear();
		const response = await request();
		expect(await response.json()).toMatchObject({
			success: true,
			data: { items: expect.arrayContaining([expect.objectContaining({ id: project.id })]) },
		});
		expect(get.mock.calls.filter(([key]) => key.startsWith(paths.snapshotsPrefix))).toHaveLength(1);
	});

	it('keeps dependencies and configuration separate for different environments', async () => {
		const firstEnv = makeEnv();
		const secondEnv = { ...makeEnv(), MARIMOHUB_THEME_NAME: 'Other hub' };
		const request = new Request('https://hub.example.com/api/v1/theme');
		const first = buildDeps(request, firstEnv);
		const second = buildDeps(request, secondEnv);
		expect(buildDeps(request, firstEnv)).toBe(first);
		expect(second.bucket).not.toBe(first.bucket);
		expect(second.services).not.toBe(first.services);
		expect(second.compute).not.toBe(first.compute);
		expect(second.authenticator).not.toBe(first.authenticator);
		const response = await worker.fetch(request, secondEnv, makeContext());
		expect(await response.json()).toMatchObject({ data: { name: 'Other hub' } });
	});

	it('checks the request hostname even after the API is cached', async () => {
		const env = { ...makeEnv(), SANDBOX_HOSTNAME: 'sandbox.example.net' };
		expect((await fetchApi(env, '/api/v1/theme')).status).toBe(200);
		const response = await worker.fetch(
			new Request('https://sandbox.example.net/api/v1/theme'),
			env,
			makeContext(),
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: { code: 'CONFIG_ERROR', message: expect.stringContaining('shares an origin') },
		});
	});

	it('retries dependency construction after a transient initialization failure', async () => {
		const env = makeEnv();
		const fetch = () => fetchApi(env, '/api/v1/theme');
		vi.mocked(R2BucketAdapter).mockImplementationOnce(function () {
			throw new Error('binding unavailable');
		});

		const failed = await fetch();
		expect(failed.status).toBe(500);
		expect(await failed.json()).toMatchObject({
			error: { code: 'CONFIG_ERROR', message: 'binding unavailable' },
		});
		expect((await fetch()).status).toBe(200);
		expect((await fetch()).status).toBe(200);
	});

	it.each([
		{ AUTH_MODE: undefined },
		{ AUTH_MODE: 'access' as const, ACCESS_TEAM: 'team', ACCESS_AUD: '' },
		{ SECRETS_KEK: 'invalid' },
	])(
		'fails closed on repeated invalid configuration and accepts a corrected environment: %j',
		async (invalid) => {
			const valid = makeEnv();
			const env = { ...valid, ...invalid };
			const fetch = (bindings: Env) => fetchApi(bindings);
			for (let i = 0; i < 2; i++) {
				const response = await fetch(env);
				expect(response.status).toBe(500);
				expect(await response.json()).toMatchObject({
					success: false,
					error: { code: 'CONFIG_ERROR' },
				});
			}
			expect((await fetch(valid)).status).toBe(200);
			expect((await fetch(env)).status).toBe(500);
		},
	);

	it('applies changed authentication bindings even when storage and compute bindings are unchanged', async () => {
		const dev = makeEnv();
		const access: Env = {
			...dev,
			AUTH_MODE: 'access',
			ACCESS_TEAM: 'team',
			ACCESS_AUD: 'audience',
		};
		const fetch = (env: Env) => fetchApi(env);
		expect((await fetch(dev)).status).toBe(200);
		const denied = await fetch(access);
		expect(denied.status).toBe(401);
		expect(await denied.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
		expect((await fetch(dev)).status).toBe(200);
		expect((await fetch(access)).status).toBe(401);
	});

	it('retries a failed snapshot read without replacing shared dependencies', async () => {
		const bucket = new MemoryBucket();
		await createServices(bucket).catalog.initialize(ACTOR);
		const env = makeEnv(bucket);
		const request = new Request('https://hub.example.com/api/v1/projects');
		const deps = buildDeps(request, env);
		const originalGet = bucket.get.bind(bucket);
		let fail = true;
		const get = vi.spyOn(bucket, 'get').mockImplementation(async (key, options) => {
			if (key.startsWith(paths.snapshotsPrefix) && fail) {
				fail = false;
				throw new Error('snapshot unavailable');
			}
			return originalGet(key, options);
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const failed = await worker.fetch(request, env, makeContext());
		expect(failed.status).toBe(500);
		expect(await failed.json()).toMatchObject({
			success: false,
			error: { code: 'INTERNAL_ERROR' },
		});
		for (let i = 0; i < 2; i++) {
			const response = await worker.fetch(new Request(request), env, makeContext());
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				data: { items: [expect.objectContaining({ name: 'My Project' })] },
			});
		}
		expect(buildDeps(request, env)).toBe(deps);
		expect(get.mock.calls.filter(([key]) => key.startsWith(paths.snapshotsPrefix))).toHaveLength(2);
	});

	it('shares an uncached snapshot load across overlapping requests', async () => {
		const bucket = new MemoryBucket();
		const writer = createServices(bucket);
		await writer.catalog.initialize(ACTOR);
		const env = makeEnv(bucket);
		const fetch = () => fetchApi(env, '/api/v1/projects');
		expect((await fetch()).status).toBe(200);
		await writer.projects.createProject({ name: 'New project', description: '' }, ACTOR);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const secondPointerRead = Promise.withResolvers<void>();
		let snapshotPending = false;
		const originalGet = bucket.get.bind(bucket);
		const get = vi.spyOn(bucket, 'get').mockImplementation(async (key, options) => {
			if (key === paths.catalog && snapshotPending) secondPointerRead.resolve();
			if (key.startsWith(paths.snapshotsPrefix)) {
				snapshotPending = true;
				entered.resolve();
				await release.promise;
			}
			return originalGet(key, options);
		});
		const first = fetch();
		await entered.promise;
		const second = fetch();
		try {
			await secondPointerRead.promise;
		} finally {
			release.resolve();
		}
		const responses = await Promise.all([first, second]);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(await responses[0].json()).toEqual(await responses[1].json());
		expect(get.mock.calls.filter(([key]) => key.startsWith(paths.snapshotsPrefix))).toHaveLength(1);
	});

	it('hands rejected background work to its invocation without retaining the context afterward', async () => {
		const env = makeEnv();
		const deps = buildDeps(new Request('https://hub.example.com'), env);
		const failure = new Error('background failure');
		const outcomes: Promise<unknown>[] = [];
		const ctx = makeContext();
		vi.mocked(ctx.waitUntil).mockImplementation((task) => {
			outcomes.push(task.catch((error: unknown) => error));
		});
		const authenticate = deps.authenticator.authenticate.bind(deps.authenticator);
		vi.spyOn(deps.authenticator, 'authenticate').mockImplementationOnce(async (request) => {
			await deps.backgroundWork!.defer('test', () => Promise.reject(failure));
			return authenticate(request);
		});
		const request = new Request('https://hub.example.com/api/v1/capabilities');
		expect((await worker.fetch(request, env, ctx)).status).toBe(200);
		expect(await Promise.all(outcomes)).toEqual([undefined, failure]);
		expect((await worker.fetch(new Request(request), env, makeContext())).status).toBe(200);
		await expect(
			deps.backgroundWork!.defer('outside-request', () => Promise.reject(failure)),
		).rejects.toBe(failure);
		expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
	});

	it('registers concurrent background work with the originating execution context', async () => {
		const env = makeEnv();
		const deps = buildDeps(new Request('https://hub.example.com'), env);
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const firstTask = Promise.resolve();
		const secondTask = Promise.resolve();
		const tasks = [firstTask, secondTask];
		const authenticate = deps.authenticator.authenticate.bind(deps.authenticator);
		vi.spyOn(deps.authenticator, 'authenticate').mockImplementation(async (request) => {
			const index = Number(request.headers.get('x-request-index'));
			if (index === 0) {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
			await deps.backgroundWork!.defer('test', () => tasks[index]);
			return authenticate(request);
		});
		const contexts = [makeContext(), makeContext()];
		const fetch = (index: number) =>
			worker.fetch(
				new Request('https://hub.example.com/api/v1/capabilities', {
					headers: { 'x-request-index': String(index) },
				}),
				env,
				contexts[index],
			);
		const first = fetch(0);
		await firstEntered.promise;
		expect((await fetch(1)).status).toBe(200);
		expect(contexts[0].waitUntil).toHaveBeenCalledOnce();
		expect(contexts[1].waitUntil).toHaveBeenCalledOnce();
		releaseFirst.resolve();
		expect((await first).status).toBe(200);
		expect(contexts[0].waitUntil).toHaveBeenCalledTimes(2);
		expect(contexts[1].waitUntil).toHaveBeenCalledOnce();
		for (const ctx of contexts)
			await Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map(([task]) => task));
	});
});

describe('Cloudflare Worker configuration', () => {
	it('supports disabling automatic thumbnails while keeping uploads available', () => {
		const deps = buildDeps(new Request('https://hub.example.com'), {
			AUTH_MODE: 'dev',
			NOTEBOOKS_BUCKET: {},
			SANDBOX: {},
			MARIMOHUB_AUTOMATIC_THUMBNAILS: 'false',
		} as unknown as Env);
		expect(deps.sandbox.automaticThumbnails).toBe(false);
		expect(deps.services.notebooks.thumbnails).toBeDefined();
	});

	it('hides configured profiles while warning that Cloudflare ignores them', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const deps = buildDeps(new Request('https://hub.example.com'), {
			AUTH_MODE: 'dev',
			USER_ID: 'user-test',
			USER_EMAIL: 'test@example.com',
			NOTEBOOKS_BUCKET: {},
			SANDBOX: {},
			MARIMOHUB_COMPUTE_PROFILES: 'small:cpu=1;mem=2Gi,large:cpu=4;mem=8Gi',
		} as unknown as Env);

		expect(deps.sandbox.computeProfile).toBeUndefined();
		expect(deps.sandbox.computeProfiles).toEqual([]);
		expect(deps.sandbox.computeProfileOverride).toBe('none');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('profiles are ignored'));
	});

	const baseEnv = makeEnv();

	it('does not advertise previews without a source-control registry', async () => {
		const response = await worker.fetch(
			new Request('https://hub.example.com/api/v1/capabilities'),
			{ ...baseEnv, NOTEBOOKS_BUCKET: new MemoryBucket() } as unknown as Env,
			makeContext(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			data: { source_control: { preview_providers: [] } },
		});
	});

	it('wires public deployment branding', async () => {
		const response = await worker.fetch(
			new Request('https://hub.example.com/api/v1/theme'),
			{
				...baseEnv,
				MARIMOHUB_THEME_NAME: 'Research Hub',
				MARIMOHUB_THEME_PRIMARY_COLOR: '#2563eb',
			} as Env,
			makeContext(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			data: { name: 'Research Hub', primary_color: '#2563eb' },
		});
	});

	it('serves installation branding through the shared backend', async () => {
		const env = {
			...baseEnv,
			MARIMOHUB_THEME_NAME: 'Research Hub',
			MARIMOHUB_THEME_PRIMARY_COLOR: '#2563eb',
			MARIMOHUB_THEME_PWA_ICON_192: '/brand/192.png',
			MARIMOHUB_THEME_APPLE_TOUCH_ICON: '/brand/apple.png',
		} as Env;
		const ctx = makeContext();
		const response = await worker.fetch(
			new Request('https://hub.example.com/manifest.webmanifest'),
			env,
			ctx,
		);
		expect(response.headers.get('content-type')).toBe('application/manifest+json');
		expect(await response.json()).toMatchObject({
			name: 'Research Hub',
			theme_color: '#2563eb',
			icons: [{ src: '/brand/192.png' }, { src: '/icons/icon-512.png' }],
		});
		const icon = await worker.fetch(
			new Request('https://hub.example.com/apple-touch-icon.png'),
			env,
			ctx,
		);
		expect(icon.status).toBe(302);
		expect(icon.headers.get('location')).toBe('/brand/apple.png');
	});

	it('preserves the notebook CSS cache scope across requests in one deployment', () => {
		const env = {
			...baseEnv,
			MARIMOHUB_THEME_NOTEBOOK_CSS: 'https://cdn.example.com/brand.css',
		} as Env;
		const first = buildDeps(new Request('https://hub.example.com'), env);
		const next = buildDeps(new Request('https://hub.example.com/projects'), env);
		const other = buildDeps(new Request('https://other.example.com'), { ...env });
		expect(next.theme).toBe(first.theme);
		expect(other.theme).toEqual(first.theme);
		expect(other.theme).not.toBe(first.theme);
	});

	it('forwards the configured base URL for root-relative notebook CSS', () => {
		const deps = buildDeps(new Request('https://untrusted.example.com'), {
			...baseEnv,
			MARIMOHUB_THEME_NOTEBOOK_CSS: '/brand.css',
			MARIMOHUB_APP_BASE_URL: ' https://hub.example.com/team/ ',
		} as Env);
		expect(deps.theme?.notebook_css).toBe('/brand.css');
		expect(deps.sandbox.appBaseUrl).toBe('https://hub.example.com/team/');
	});

	it.each([
		{ MARIMOHUB_THEME_PRIMARY_COLOR: 'rgb(1,2,3)' },
		{ MARIMOHUB_THEME_LOGO_DARK: 'javascript:alert(1)' },
	])('rejects invalid theme configuration at the Worker request boundary: %j', async (theme) => {
		const response = await worker.fetch(
			new Request('https://hub.example.com/api/v1/theme'),
			{ ...baseEnv, ...theme } as Env,
			makeContext(),
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			success: false,
			error: {
				code: 'CONFIG_ERROR',
				message: expect.stringContaining(Object.keys(theme)[0]),
			},
		});
	});

	it.each([
		[undefined, 'off'],
		['', 'off'],
		[' \t\n', 'off'],
		['off', 'off'],
		[' OFF ', 'off'],
		['on', 'on'],
		[' ON ', 'on'],
	])('parses sandbox authentication %j as %s', (raw, expected) => {
		const deps = buildDeps(new Request('https://hub.example.com'), {
			...baseEnv,
			MARIMOHUB_SANDBOX_AUTH: raw,
		} as unknown as Env);
		expect(deps.sandbox.auth).toBe(expected);
	});

	it.each(['true', 'false', 'none', 'partitioned'])(
		'rejects invalid sandbox authentication %s at the request boundary',
		async (raw) => {
			const response = await worker.fetch(
				new Request('https://hub.example.com/api/v1/capabilities'),
				{ ...baseEnv, MARIMOHUB_SANDBOX_AUTH: raw } as unknown as Env,
				makeContext(),
			);
			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({
				success: false,
				error: {
					code: 'CONFIG_ERROR',
					message: `Invalid MARIMOHUB_SANDBOX_AUTH: ${raw} (expected on, off)`,
				},
			});
		},
	);

	it('parses MARIMOHUB_SUPER_ADMINS into a trimmed list, dropping empties', () => {
		const deps = buildDeps(new Request('https://hub.example.com'), {
			...baseEnv,
			MARIMOHUB_SUPER_ADMINS: 'admin@example.com, user-1 ,',
		} as unknown as Env);
		expect(deps.policy.superAdmins).toEqual(['admin@example.com', 'user-1']);
	});

	it('leaves superAdmins undefined when MARIMOHUB_SUPER_ADMINS is unset', () => {
		const deps = buildDeps(new Request('https://hub.example.com'), baseEnv as unknown as Env);
		expect(deps.policy.superAdmins).toBeUndefined();
	});

	it('defaults and canonicalizes editor sandbox sharing', () => {
		expect(
			buildDeps(new Request('https://hub.example.com'), baseEnv as unknown as Env).policy
				.editorSandboxSharing,
		).toBe('shared');
		expect(
			buildDeps(new Request('https://hub.example.com'), {
				...baseEnv,
				MARIMOHUB_EDITOR_SANDBOX_SHARING: ' EXCLUSIVE ',
			} as unknown as Env).policy.editorSandboxSharing,
		).toBe('exclusive');
	});

	it('keeps notebook jobs off unless MARIMOHUB_JOBS=on, and rejects other values', () => {
		const at = (jobs?: string) =>
			buildDeps(new Request('https://hub.example.com'), {
				...baseEnv,
				MARIMOHUB_JOBS: jobs,
			} as Env).jobs;
		expect(at()).toBeUndefined();
		expect(at('off')).toBeUndefined();
		expect(at(' ON ')).toBeDefined();
		expect(() => at('yes')).toThrow('Unknown MARIMOHUB_JOBS: yes (supported: on, off).');
	});

	it('rejects an invalid editor sandbox sharing value', () => {
		expect(() =>
			buildDeps(new Request('https://hub.example.com'), {
				...baseEnv,
				MARIMOHUB_EDITOR_SANDBOX_SHARING: 'per-user',
			} as unknown as Env),
		).toThrow('Invalid MARIMOHUB_EDITOR_SANDBOX_SHARING: per-user (expected shared, exclusive)');
	});

	it('keeps default-role environment types aligned with assignable roles', () => {
		expectTypeOf<Env['DEFAULT_ROLE']>().toEqualTypeOf<AssignableRole | 'none' | undefined>();
	});

	it.each([...ASSIGNABLE_ROLES, 'none'] as const)('accepts typed default role %s', (role) => {
		const env: Env = {
			AUTH_MODE: 'dev',
			USER_ID: 'user-test',
			USER_EMAIL: 'test@example.com',
			NOTEBOOKS_BUCKET: new MemoryBucket() as never,
			SANDBOX: {} as never,
			DEFAULT_ROLE: role,
		};
		expect(buildDeps(new Request('https://hub.example.com'), env).policy.defaultRole).toBe(
			role === 'none' ? undefined : role,
		);
	});

	it.each(['admin', 'owner', 'app', 'app_user', 'unknown'])(
		'rejects unsupported default role %s',
		(role) => {
			expect(() =>
				buildDeps(new Request('https://hub.example.com'), {
					...baseEnv,
					DEFAULT_ROLE: role,
				} as unknown as Env),
			).toThrow(`Invalid DEFAULT_ROLE: ${role} (expected ${ASSIGNABLE_ROLES.join(', ')}, none)`);
		},
	);
});

describe('Cloudflare Worker scheduled handler', () => {
	const controller: ScheduledController = {
		scheduledTime: 0,
		cron: '*/5 * * * *',
		noRetry() {},
	};
	const scheduledEnv = (): Env => ({ ...makeEnv(), MARIMOHUB_JOBS: 'on' });

	it.each([
		{ AUTH_MODE: 'invalid' },
		{ SECRETS_KEK: 'invalid' },
		{ MARIMOHUB_COMPUTE_PROFILES: 'invalid' },
	])('runs maintenance without validating unrelated request configuration: %j', async (invalid) => {
		const env = scheduledEnv();
		await createServices(env.NOTEBOOKS_BUCKET as unknown as MemoryBucket).catalog.initialize(ACTOR);
		const expire = vi.spyOn(SessionService.prototype, 'expireStale');
		const release = vi.spyOn(MaintenanceLock.prototype, 'release');
		await worker.scheduled(
			controller,
			{
				...env,
				...invalid,
				MARIMOHUB_JOBS: 'off',
			} as Env,
			makeContext(),
		);
		expect(expire).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledWith('cloudflare-scheduled');
	});

	it('reuses fetch services while releasing the lease and context after maintenance fails', async () => {
		const env: Env = { ...scheduledEnv(), MARIMOHUB_JOBS: 'off' };
		const request = new Request('https://hub.example.com/api/v1/capabilities');
		const deps = buildDeps(request, env);
		const tasks: Promise<unknown>[] = [];
		const ctx = makeContext(
			vi.fn((task: Promise<unknown>) => {
				tasks.push(task);
			}),
		);
		const expire = vi
			.spyOn(deps.services.sessions, 'expireStale')
			.mockImplementationOnce(async () => {
				await deps.backgroundWork!.defer('scheduled', async () => {});
				throw new Error('maintenance failed');
			});
		const release = vi.spyOn(MaintenanceLock.prototype, 'release');
		await expect(worker.scheduled(controller, env, ctx)).rejects.toThrow('maintenance failed');
		await Promise.all(tasks);
		expect(expire).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledWith('cloudflare-scheduled');
		expect(ctx.waitUntil).toHaveBeenCalledOnce();
		expect((await worker.fetch(request, env, makeContext())).status).toBe(200);
		await expect(
			deps.backgroundWork!.defer('outside-scheduled', () =>
				Promise.reject(new Error('inline failure')),
			),
		).rejects.toThrow('inline failure');
		expect(ctx.waitUntil).toHaveBeenCalledOnce();
	});

	function mockJobScheduler(dispatched = 0) {
		vi.spyOn(MaintenanceLock.prototype, 'acquire')
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		vi.spyOn(MaintenanceLock.prototype, 'release').mockResolvedValue(undefined);
		const tick = vi.spyOn(JobScheduler.prototype, 'tick').mockResolvedValue({
			fired: 0,
			repaired: 0,
			skipped: 0,
			dispatched,
			timedOut: 0,
			markersPruned: 0,
			errors: 0,
		});
		const prune = vi.spyOn(JobScheduler.prototype, 'prune').mockResolvedValue({
			runsPruned: 0,
			markersPruned: 0,
		});
		const drain = vi.spyOn(JobScheduler.prototype, 'drain').mockResolvedValue(undefined);
		return { tick, prune, drain };
	}

	it('runs the job scheduler when the maintenance lease is unavailable', async () => {
		const { tick } = mockJobScheduler();

		await worker.scheduled(controller, scheduledEnv(), makeContext());

		expect(tick).toHaveBeenCalledOnce();
	});

	it('registers the execution drain before pruning', async () => {
		const { prune, drain } = mockJobScheduler(1);
		const drainPromise = Promise.resolve();
		drain.mockReturnValue(drainPromise);
		prune.mockRejectedValue(new Error('prune failed'));
		const waitUntil = vi.fn();

		await expect(
			worker.scheduled(controller, scheduledEnv(), makeContext(waitUntil)),
		).rejects.toThrow('prune failed');

		expect(waitUntil).toHaveBeenCalledWith(drainPromise);
	});
});

describe('Cloudflare Worker sandbox-host isolation guard', () => {
	const baseEnv = makeEnv();

	it.each(['sandboxes.example.net', 'sandboxes.example.com'])(
		'allows sandbox hostname %s',
		(hostname) => {
			expect(() =>
				buildDeps(new Request('https://hub.example.com/'), {
					...baseEnv,
					SANDBOX_HOSTNAME: hostname,
				} as unknown as Env),
			).not.toThrow();
		},
	);

	it('rejects a sandbox hostname that differs from the app host only in case', () => {
		expect(() =>
			buildDeps(new Request('https://hub.example.com/'), {
				...baseEnv,
				SANDBOX_HOSTNAME: 'Hub.Example.Com',
			} as unknown as Env),
		).toThrow(/shares an origin/);
	});

	it('rejects a sandbox hostname that differs from the app host only by whitespace', () => {
		expect(() =>
			buildDeps(new Request('https://hub.example.com/'), {
				...baseEnv,
				SANDBOX_HOSTNAME: ' hub.example.com ',
			} as unknown as Env),
		).toThrow(/shares an origin/);
	});
});

describe('scheduled migrations', () => {
	it('runs migration batches only on scheduled events', async () => {
		const bucket = new MemoryBucket();
		const services = createServices(bucket);
		await services.catalog.initialize(ACTOR);
		const project = await services.projects.createProject(
			{ name: 'Existing', description: '' },
			ACTOR,
		);
		await services.catalog.updateProjectEntry('test.legacy', ACTOR, project.id, () => ({
			access: undefined,
		}));
		const env = makeEnv(bucket);
		const get = vi.spyOn(bucket, 'get');
		await fetchApi(env);
		expect(await bucket.get(paths.migration('project-access-v1'))).toBeNull();
		await worker.scheduled({} as ScheduledController, env, makeContext());
		expect((await services.catalog.getCurrentSnapshot()).projects[0].access?.version).toBe(1);
		await worker.scheduled({} as ScheduledController, env, makeContext());
		get.mockClear();
		await worker.scheduled({} as ScheduledController, env, makeContext());
		expect(get.mock.calls.some(([key]) => key.startsWith('_system/migrations/'))).toBe(false);
	});

	it('still runs maintenance if a migration fails', async () => {
		const bucket = new MemoryBucket();
		await createServices(bucket).catalog.initialize(ACTOR);
		vi.spyOn(MigrationService.prototype, 'tick').mockRejectedValueOnce(
			new Error('migration unavailable'),
		);
		const expire = vi.spyOn(SessionService.prototype, 'expireStale');
		await expect(
			worker.scheduled({} as ScheduledController, makeEnv(bucket), makeContext()),
		).rejects.toThrow('migration unavailable');
		expect(expire).toHaveBeenCalled();
	});
});

it('does not start scheduled work if shared resource construction fails', async () => {
	vi.mocked(R2BucketAdapter).mockImplementationOnce(() => {
		throw new Error('binding unavailable');
	});
	const migrations = vi.spyOn(MigrationService.prototype, 'tick');
	const expire = vi.spyOn(SessionService.prototype, 'expireStale');
	await expect(
		worker.scheduled({} as ScheduledController, makeEnv(), makeContext()),
	).rejects.toThrow('binding unavailable');
	expect(migrations).not.toHaveBeenCalled();
	expect(expire).not.toHaveBeenCalled();
});

it('learns migration completion on a fresh HTTP isolate without running a batch', async () => {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	await services.catalog.initialize(ACTOR);
	while (!(await services.migrations.tick())) {}
	const env = makeEnv(bucket);
	const tasks: Promise<unknown>[] = [];
	const ctx = makeContext(vi.fn((task) => tasks.push(task)));
	const tick = vi.spyOn(MigrationService.prototype, 'tick');
	expect((await fetchApi(env, undefined, ctx)).status).toBe(200);
	await Promise.all(tasks);
	const deps = buildDeps(new Request('https://hub.example.com'), env);
	expect(deps.services.migrations.isComplete('session-index-v1')).toBe(true);
	expect(tick).not.toHaveBeenCalled();
	const get = vi.spyOn(bucket, 'get');
	const second = makeContext();
	await fetchApi(env, undefined, second);
	expect(second.waitUntil).not.toHaveBeenCalled();
	expect(get.mock.calls.some(([key]) => key.startsWith('_system/migrations/'))).toBe(false);
});

it('keeps HTTP requests available when background receipt refresh fails', async () => {
	const bucket = new MemoryBucket();
	const get = bucket.get.bind(bucket);
	vi.spyOn(bucket, 'get').mockImplementation((key, ...args) => {
		if (key.startsWith('_system/migrations/')) throw new Error('receipts unavailable');
		return get(key, ...args);
	});
	const env = makeEnv(bucket);
	const tasks: Promise<unknown>[] = [];
	expect(
		(await fetchApi(env, undefined, makeContext(vi.fn((task) => tasks.push(task))))).status,
	).toBe(200);
	expect(tasks).toHaveLength(1);
	await Promise.all(tasks);
	expect(
		buildDeps(new Request('https://hub.example.com'), env).services.migrations.isComplete(
			'session-index-v1',
		),
	).toBe(false);
});

it('requires an invocation context before starting a manual migration attempt', async () => {
	const deps = buildDeps(new Request('https://hub.example.com'), makeEnv());
	const tick = vi.spyOn(deps.services.migrations, 'tick');
	await expect(deps.requestMigrationTick!()).rejects.toThrow('context unavailable');
	expect(tick).not.toHaveBeenCalled();
});

it('registers manual migration work on the request invocation without awaiting its batch', async () => {
	const env = { ...makeEnv(), MARIMOHUB_SUPER_ADMINS: ACTOR };
	const gate = Promise.withResolvers<boolean>();
	const tick = vi.spyOn(MigrationService.prototype, 'tick').mockReturnValue(gate.promise);
	const tasks: Promise<unknown>[] = [];
	const ctx = makeContext(vi.fn((work) => tasks.push(work)));
	const response = await worker.fetch(
		new Request('https://hub.example.com/api/v1/admin/migrations/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		}),
		env,
		ctx,
	);
	expect(response.status).toBe(202);
	expect(tick).toHaveBeenCalledOnce();
	expect(tasks.length).toBeGreaterThan(0);
	gate.resolve(true);
	await Promise.allSettled(tasks);
});
