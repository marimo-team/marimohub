import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createServices, paths } from '@marimo-hub/core';
import type { DeepLink, DeepLinkTarget, ProjectAction } from '@marimo-hub/core';
import { ACTOR, uid, localResourceSecurity, makeSubjectContext } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

let api: ReturnType<typeof createTestApi>;
let target: DeepLinkTarget;
let base: string;

beforeEach(async () => {
	const bucket = await createInitializedBucket();
	const services = createServices(bucket);
	const project = await services.projects.createProject({ name: 'Apps', description: '' }, ACTOR);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'Sales', description: '', code: 'import marimo' },
		ACTOR,
	);
	target = { kind: 'app', project_id: project.id, notebook_id: notebook.id };
	api = createTestApi({ bucket });
	base = `/projects/${project.id}/notebooks/${notebook.id}/deep-links`;
});
afterEach(() => vi.restoreAllMocks());

async function createLink() {
	return expectOk<DeepLink>(await api.request('POST', base, { slug: 'sales' }));
}

describe('App link routes', () => {
	it('registers, lists, resolves without caching or listing, and releases', async () => {
		const link = await createLink();
		expect(await createLink()).toEqual(link);
		expect(await expectOk(await api.request('GET', base))).toEqual([link]);
		const list = vi.spyOn(api.bucket, 'list');
		const response = await api.request('GET', '/deep-links/sales');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('etag')).toBeNull();
		expect(await expectOk(response)).toEqual(link);
		expect(list).not.toHaveBeenCalled();
		await expectOk(
			await api.request('DELETE', `${base}/sales?registration_id=${link.registration_id}`),
		);
		const missing = await api.request('GET', '/deep-links/sales');
		expect(missing.headers.get('cache-control')).toBe('no-store');
		await expectError(missing, 404);
	});

	it('requires authentication', async () => {
		await createLink();
		const anonymous = createTestApi({
			bucket: api.bucket,
			deps: { authenticator: { authenticate: async () => null } },
		});
		for (const path of ['/deep-links/sales', base]) {
			const response = await anonymous.request('GET', path);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('etag')).toBeNull();
			await expectError(response, 401);
		}
		await expectError(await anonymous.request('POST', base, { slug: 'other' }), 401);
	});

	it('masks a notebook from a nonmember', async () => {
		await createLink();
		const outsider = createTestApi({ bucket: api.bucket, userId: uid('outsider') });
		for (const path of ['/deep-links/sales', base]) {
			const response = await outsider.request('GET', path);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('etag')).toBeNull();
			await expectError(response, 404);
		}
	});

	it('never conditionally caches resolutions or notebook alias lists', async () => {
		const link = await createLink();
		for (const path of ['/deep-links/sales', base]) {
			const response = await api.app.request(`/api/v1${path}`, {
				headers: { 'If-None-Match': '*' },
			});
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('etag')).toBeNull();
			expect(await expectOk(response)).toEqual(path === base ? [link] : link);
		}

		await expectOk(
			await api.request('DELETE', `${base}/sales?registration_id=${link.registration_id}`),
		);
		const response = await api.app.request(`/api/v1${base}`, {
			headers: { 'If-None-Match': '*' },
		});
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('etag')).toBeNull();
		expect(await expectOk(response)).toEqual([]);
	});

	it('does not cache failed notebook alias listings', async () => {
		await createLink();
		vi.spyOn(api.deps.services.deepLinks, 'list').mockRejectedValueOnce(
			new Error('private storage endpoint failed'),
		);
		const response = await api.request('GET', base);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('etag')).toBeNull();
		const error = await expectError(response, 500, 'INTERNAL_ERROR');
		expect(JSON.stringify(error)).not.toContain('private storage endpoint');
	});

	it.each(['viewer', 'editor', 'manager'] as const)(
		'allows %s reads and only managers to write',
		async (role) => {
			const userId = uid(role);
			await api.deps.services.projects.addMember(
				target.project_id,
				{ user_id: userId },
				role,
				ACTOR,
			);
			const link = await createLink();
			const member = createTestApi({ bucket: api.bucket, userId });
			await expectOk(await member.request('GET', '/deep-links/sales'));
			await expectOk(await member.request('GET', base));
			const add = await member.request('POST', base, { slug: 'second' });
			const remove = await member.request(
				'DELETE',
				`${base}/sales?registration_id=${link.registration_id}`,
			);
			if (role === 'manager') {
				await expectOk(add);
				await expectOk(remove);
			} else {
				await expectError(add, 403);
				await expectError(remove, 403);
			}
		},
	);

	it('does not grant viewer session admission through a slug', async () => {
		const userId = uid('viewer');
		await api.deps.services.projects.addMember(
			target.project_id,
			{ user_id: userId },
			'viewer',
			ACTOR,
		);
		await createLink();
		const viewer = createTestApi({
			bucket: api.bucket,
			userId,
			deps: { policy: { viewerMode: 'static' } },
		});
		await expectOk(await viewer.request('GET', '/deep-links/sales'));
		await expectError(
			await viewer.request(
				'POST',
				`/projects/${target.project_id}/notebooks/${target.notebook_id}/sessions`,
				{ mode: 'app' },
			),
			403,
		);
	});

	it('enforces token action and project grants', async () => {
		await createLink();
		const tokenApi = (actions: ProjectAction[], projects: (typeof target.project_id)[]) =>
			createTestApi({
				bucket: api.bucket,
				deps: {
					authenticator: {
						authenticate: async () => ({
							id: ACTOR,
							email: 'actor@example.com',
							credential: { kind: 'personal-access-token', grant: { actions, projects } },
						}),
					},
				},
			});
		const readOnly = tokenApi(['project.read'], [target.project_id]);
		await expectOk(await readOnly.request('GET', '/deep-links/sales'));
		await expectError(await readOnly.request('POST', base, { slug: 'token' }), 403);
		const writer = tokenApi(['project.read', 'deep-link.manage'], [target.project_id]);
		await expectOk(await writer.request('POST', base, { slug: 'token' }));
		const restricted = tokenApi(['project.read', 'deep-link.manage'], []);
		await expectError(await restricted.request('GET', '/deep-links/sales'), 404);
	});

	it('enforces notebook security labels for resolution and management', async () => {
		await createLink();
		const key = paths.project(target.project_id).notebook(target.notebook_id).meta;
		const meta = await (await api.bucket.get(key))!.json<Record<string, unknown>>();
		await api.bucket.put(
			key,
			JSON.stringify({
				...meta,
				security_labels: { classification: 'SECRET', compartments: ['finance'] },
			}),
		);
		const constrained = createTestApi({
			bucket: api.bucket,
			deps: {
				resourceSecurity: localResourceSecurity(
					['UNCLASSIFIED', 'SECRET'],
					makeSubjectContext({ compartments: [] }),
				),
			},
		});
		await expectError(await constrained.request('GET', '/deep-links/sales'), 404);
		await expectError(await constrained.request('POST', base, { slug: 'hidden' }), 404);
	});

	it.each([
		{ slug: 'UPPER' },
		{ slug: '-sales' },
		{ slug: 'a/b' },
		{ slug: 'a'.repeat(64) },
		{ slug: 'sales', kind: 'notebook' },
		{ slug: 'sales', access: { mode: 'public' } },
	])('rejects invalid input %j', async (body) => {
		await expectError(await api.request('POST', base, body), 422);
	});

	it('requires the registration ID for release', async () => {
		await createLink();
		await expectError(await api.request('DELETE', `${base}/sales`), 422);
	});

	it.each(['notebook', 'project'] as const)('returns 404 after %s deletion', async (kind) => {
		await createLink();
		if (kind === 'notebook')
			await api.deps.services.notebooks.deleteNotebook(
				target.project_id,
				target.notebook_id,
				ACTOR,
			);
		else await api.deps.services.projects.deleteProject(target.project_id, ACTOR);
		await expectError(await api.request('GET', '/deep-links/sales'), 404);
	});
	it('returns a conflict without revealing the existing target to another project owner', async () => {
		const link = await createLink();
		const userId = uid('other-owner');
		const project = await api.deps.services.projects.createProject(
			{ name: 'Other', description: '' },
			userId,
		);
		const notebook = await api.deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Other', description: '', code: 'import marimo' },
			userId,
		);
		const other = createTestApi({ bucket: api.bucket, userId });
		const otherBase = `/projects/${project.id}/notebooks/${notebook.id}/deep-links`;
		const conflict = await expectError(
			await other.request('POST', otherBase, { slug: 'sales' }),
			409,
			'CONFLICT',
		);
		expect(JSON.stringify(conflict)).not.toContain(target.project_id);
		expect(JSON.stringify(conflict)).not.toContain(target.notebook_id);
		await expectOk(
			await other.request('DELETE', `${otherBase}/sales?registration_id=${link.registration_id}`),
		);
		expect(await expectOk(await api.request('GET', '/deep-links/sales'))).toEqual(link);
	});

	it('ignores an old removal after a slug is released and registered again', async () => {
		const old = await createLink();
		await expectOk(
			await api.request('DELETE', `${base}/sales?registration_id=${old.registration_id}`),
		);
		const current = await createLink();
		expect(current.registration_id).not.toBe(old.registration_id);
		await expectOk(
			await api.request('DELETE', `${base}/sales?registration_id=${old.registration_id}`),
		);
		expect(await expectOk(await api.request('GET', '/deep-links/sales'))).toEqual(current);
	});

	it('checks access again after project membership is revoked', async () => {
		const userId = uid('former-member');
		await api.deps.services.projects.addMember(
			target.project_id,
			{ user_id: userId },
			'manager',
			ACTOR,
		);
		const link = await createLink();
		const member = createTestApi({ bucket: api.bucket, userId });
		await expectOk(await member.request('GET', '/deep-links/sales'));
		await api.deps.services.projects.removeMember(target.project_id, userId, ACTOR);
		await expectError(await member.request('GET', '/deep-links/sales'), 404);
		await expectError(await member.request('GET', base), 404);
		await expectError(
			await member.request('DELETE', `${base}/sales?registration_id=${link.registration_id}`),
			403,
		);
		expect(await expectOk(await api.request('GET', '/deep-links/sales'))).toEqual(link);
	});

	it('returns an uncached error without storage details when resolution fails', async () => {
		await createLink();
		const get = api.bucket.get.bind(api.bucket);
		vi.spyOn(api.bucket, 'get').mockImplementation((key) => {
			if (key === paths.deepLink('sales')) throw new Error('private storage endpoint failed');
			return get(key);
		});
		const response = await api.request('GET', '/deep-links/sales');
		expect(response.headers.get('cache-control')).toBe('no-store');
		const error = await expectError(response, 500, 'INTERNAL_ERROR');
		expect(JSON.stringify(error)).not.toContain('private storage endpoint');
	});

	it('does not report success or remove ownership when release storage fails', async () => {
		const link = await createLink();
		const put = api.bucket.put.bind(api.bucket);
		vi.spyOn(api.bucket, 'put').mockImplementation((key, value, options) => {
			if (key === paths.deepLink('sales')) throw new Error('write unavailable');
			return put(key, value, options);
		});
		await expectError(
			await api.request('DELETE', `${base}/sales?registration_id=${link.registration_id}`),
			500,
			'INTERNAL_ERROR',
		);
		expect(await expectOk(await api.request('GET', '/deep-links/sales'))).toEqual(link);
	});
});
