import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createServices } from '../index';
import { ACTOR, uid } from '../../testing';
import { DeepLinkAccessSchema, DeepLinkTargetSchema } from '../../deepLinks';
import type { DeepLinkTarget } from '../../deepLinks';
import {
	ConflictError,
	NotFoundError,
	PreconditionFailedError,
	ValidationError,
} from '../../errors';
import { paths } from '../../paths';

let bucket: MemoryBucket;
let services: ReturnType<typeof createServices>;
let first: DeepLinkTarget;
let second: DeepLinkTarget;

beforeEach(async () => {
	bucket = new MemoryBucket();
	services = createServices(bucket);
	await services.catalog.initialize(ACTOR);
	const targets = [];
	for (const name of ['First', 'Second']) {
		const project = await services.projects.createProject({ name, description: '' }, ACTOR);
		const notebook = await services.notebooks.createNotebook(
			project.id,
			{ title: name, description: '', code: 'import marimo' },
			ACTOR,
		);
		targets.push({ kind: 'app' as const, project_id: project.id, notebook_id: notebook.id });
	}
	[first, second] = targets as [DeepLinkTarget, DeepLinkTarget];
});
afterEach(() => vi.restoreAllMocks());

const register = (target = first, slug = 'sales') =>
	services.deepLinks.register(slug, target, ACTOR);

describe('DeepLinkService', () => {
	it('keeps nested aliases independent through conflicts, release, reuse, and stale cleanup', async () => {
		const parent = await register(second, 'team');
		const child = await register(first, 'team/overview');
		const grandchild = await register(second, 'team/overview/details');
		expect(await register(first, child.slug)).toEqual(child);
		await expect(register(second, child.slug)).rejects.toBeInstanceOf(ConflictError);
		expect(await services.deepLinks.list(first)).toEqual([child]);
		expect(await services.deepLinks.list(second)).toEqual([parent, grandchild]);
		await services.deepLinks.release(child.slug, second, child.registration_id);
		expect(await services.deepLinks.resolve(child.slug)).toEqual(child);
		await services.deepLinks.release(child.slug, first, child.registration_id);
		await expect(services.deepLinks.resolve(child.slug)).rejects.toBeInstanceOf(NotFoundError);
		const replacement = await register(second, child.slug);
		await services.deepLinks.release(child.slug, first, child.registration_id);
		await services.deepLinks.releaseNotebook(first.project_id, first.notebook_id);
		expect(await services.deepLinks.resolve(child.slug)).toEqual(replacement);
		expect(await services.deepLinks.resolve(parent.slug)).toEqual(parent);
		expect(await services.deepLinks.resolve(grandchild.slug)).toEqual(grandchild);
	});

	it.each(['notebook', 'project'] as const)(
		'releases every nested alias during %s deletion and purges its indexes',
		async (kind) => {
			const slugs = ['team', 'team/overview', 'team/overview/details'];
			for (const slug of slugs) await register(first, slug);
			const neighbor = await register(second, 'team/other');
			const list = bucket.list.bind(bucket);
			vi.spyOn(bucket, 'list').mockImplementation((options) => list({ ...options, limit: 1 }));
			if (kind === 'notebook') {
				await services.notebooks.deleteNotebook(first.project_id, first.notebook_id, ACTOR);
				await services.notebooks.hardDeleteNotebook(first.project_id, first.notebook_id);
			} else {
				await services.projects.deleteProject(first.project_id, ACTOR);
				await services.projects.hardDeleteProject(first.project_id);
			}
			for (const slug of slugs) {
				await expect(services.deepLinks.resolve(slug)).rejects.toBeInstanceOf(NotFoundError);
				expect(await (await bucket.get(paths.deepLink(slug)))!.json()).toMatchObject({
					released: true,
				});
				expect(
					await bucket.get(
						paths.project(first.project_id).notebook(first.notebook_id).deepLinkIndex(slug),
					),
				).toBeNull();
				await register(second, slug);
			}
			expect(await services.deepLinks.resolve(neighbor.slug)).toEqual(neighbor);
		},
	);

	it('resolves with one mapping read and no listing; multiple aliases share a target', async () => {
		const link = await register();
		await register(first, 'revenue');
		const get = vi.spyOn(bucket, 'get');
		const list = vi.spyOn(bucket, 'list');
		expect(await services.deepLinks.resolve('sales')).toEqual(link);
		expect(get.mock.calls.filter(([key]) => key.startsWith('_system/deep-links/'))).toEqual([
			[paths.deepLink('sales')],
		]);
		expect(list).not.toHaveBeenCalled();
		expect((await services.deepLinks.list(first)).map((entry) => entry.slug)).toEqual([
			'revenue',
			'sales',
		]);
	});

	it('allows exactly one concurrent owner and makes same-target registration idempotent', async () => {
		const results = await Promise.allSettled([register(), register(second)]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		const failure = results.find((result) => result.status === 'rejected');
		expect(failure?.status === 'rejected' && failure.reason).toBeInstanceOf(ConflictError);
		const winner = await services.deepLinks.resolve('sales');
		expect(await register(winner.target)).toEqual(winner);
		const same = await Promise.all([register(first, 'same'), register(first, 'same')]);
		expect(same[0]).toEqual(same[1]);
	});

	it('releases for immediate reuse without deleting the key and rejects stale removal', async () => {
		const old = await register();
		const remove = vi.spyOn(bucket, 'delete');
		await services.deepLinks.release('sales', first, old.registration_id);
		await expect(services.deepLinks.resolve('sales')).rejects.toBeInstanceOf(NotFoundError);
		const next = await register(second);
		expect(next.registration_id).not.toBe(old.registration_id);
		await services.deepLinks.release('sales', first, old.registration_id);
		expect(await services.deepLinks.resolve('sales')).toEqual(next);
		expect(await services.deepLinks.list(first)).toEqual([]);
		expect(remove).not.toHaveBeenCalled();
	});

	it('keeps aliases when a project member is removed', async () => {
		const link = await register();
		const member = uid('viewer');
		await services.projects.addMember(first.project_id, { user_id: member }, 'viewer', ACTOR);
		await services.projects.removeMember(first.project_id, member, ACTOR);
		expect(await services.deepLinks.resolve('sales')).toEqual(link);
	});

	it('does not remove a same-notebook replacement using an old registration ID', async () => {
		const old = await register();
		await services.deepLinks.release('sales', first, old.registration_id);
		const next = await register();
		await services.deepLinks.release('sales', first, old.registration_id);
		expect(await services.deepLinks.resolve('sales')).toEqual(next);
	});

	it('does not release a replacement when the release CAS loses a race', async () => {
		const old = await register();
		const put = bucket.put.bind(bucket);
		let interleave = true;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (interleave && key === paths.deepLink('sales')) {
				interleave = false;
				await services.deepLinks.release('sales', first, old.registration_id);
				await register(second);
			}
			return put(key, value, options);
		});
		await services.deepLinks.release('sales', first, old.registration_id);
		expect((await services.deepLinks.resolve('sales')).target).toEqual(second);
	});

	it('writes no registration when the reverse index fails', async () => {
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation((key, value, options) => {
			if (
				key === paths.project(first.project_id).notebook(first.notebook_id).deepLinkIndex('sales')
			)
				throw new Error('index unavailable');
			return put(key, value, options);
		});
		await expect(register()).rejects.toThrow('index unavailable');
		expect(await bucket.get(paths.deepLink('sales'))).toBeNull();
	});

	it('ignores index candidates left by a failed registration and repairs on retry', async () => {
		const put = bucket.put.bind(bucket);
		const spy = vi.spyOn(bucket, 'put').mockImplementation((key, value, options) => {
			if (key === paths.deepLink('sales')) throw new Error('claim unavailable');
			return put(key, value, options);
		});
		await expect(register()).rejects.toThrow('claim unavailable');
		expect(await services.deepLinks.list(first)).toEqual([]);
		spy.mockRestore();
		const link = await register();
		expect(await services.deepLinks.list(first)).toEqual([link]);
	});

	it.each(['notebook', 'project'] as const)('releases links on %s deletion', async (kind) => {
		await register();
		if (kind === 'notebook')
			await services.notebooks.deleteNotebook(first.project_id, first.notebook_id, ACTOR);
		else await services.projects.deleteProject(first.project_id, ACTOR);
		await expect(services.deepLinks.resolve('sales')).rejects.toBeInstanceOf(NotFoundError);
		expect(await bucket.get(paths.deepLink('sales')).then((obj) => obj?.json())).toMatchObject({
			released: true,
		});
		await register(second);
		await services.deepLinks.releaseNotebook(first.project_id, first.notebook_id);
		expect((await services.deepLinks.resolve('sales')).target).toEqual(second);
	});

	it('reclaims a deleted target if cleanup failed, but fails closed on storage errors', async () => {
		await register();
		vi.spyOn(services.deepLinks, 'releaseNotebook').mockRejectedValueOnce(
			new Error('cleanup failed'),
		);
		await services.notebooks.deleteNotebook(first.project_id, first.notebook_id, ACTOR);
		await expect(services.deepLinks.resolve('sales')).rejects.toBeInstanceOf(NotFoundError);
		const get = bucket.get.bind(bucket);
		const spy = vi.spyOn(bucket, 'get').mockImplementation((key) => {
			if (key === paths.project(first.project_id).meta) throw new Error('storage unavailable');
			return get(key);
		});
		await expect(register(second)).rejects.toThrow('storage unavailable');
		spy.mockRestore();
		expect((await register(second)).target).toEqual(second);
	});

	it('releases a registration committed after deletion cleanup finished', async () => {
		const put = bucket.put.bind(bucket);
		let interleave = true;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (interleave && key === paths.deepLink('sales')) {
				interleave = false;
				await services.notebooks.deleteNotebook(first.project_id, first.notebook_id, ACTOR);
			}
			return put(key, value, options);
		});
		await expect(register()).rejects.toBeInstanceOf(NotFoundError);
		expect(await bucket.get(paths.deepLink('sales')).then((obj) => obj?.json())).toMatchObject({
			released: true,
		});
		await register(second);
	});

	it.each([
		'',
		'-sales',
		'sales-',
		'Sales',
		'sales\n',
		'sales\r',
		'a//b',
		'a/../b',
		'a/%2fb',
		'a/b\0',
		'a/b\n',
		'a/\\b',
		'/a/b',
		'a/b/',
		'a.b',
		'a_b',
		'é',
		'a'.repeat(64),
	])('rejects invalid slug %j', async (slug) => {
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		await expect(register(first, slug)).rejects.toBeInstanceOf(ValidationError);
		await expect(services.deepLinks.resolve(slug)).rejects.toBeInstanceOf(ValidationError);
		await expect(services.deepLinks.release(slug, first, 'invalid')).rejects.toBeInstanceOf(
			ValidationError,
		);
		expect(get).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	});

	it('rejects unsupported stored access policies and target kinds', async () => {
		const link = await register();
		expect(DeepLinkAccessSchema.safeParse({ mode: 'public' }).success).toBe(false);
		expect(DeepLinkTargetSchema.safeParse({ ...first, kind: 'notebook' }).success).toBe(false);
		await bucket.put(
			paths.deepLink('sales'),
			JSON.stringify({ ...link, access: { mode: 'public' } }),
		);
		await expect(services.deepLinks.resolve('sales')).rejects.toThrow();
		await expect(register(second)).rejects.toThrow();
	});
	it.each(['a', '0', 'a'.repeat(63), 'sales--2026'])(
		'accepts the boundary slug %s',
		async (slug) => {
			const link = await register(first, slug);
			expect(await services.deepLinks.resolve(slug)).toEqual(link);
		},
	);

	it('recovers the committed registration when its write response is lost', async () => {
		const put = bucket.put.bind(bucket);
		const spy = vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			const result = await put(key, value, options);
			if (key === paths.deepLink('sales')) throw new Error('response lost');
			return result;
		});
		await expect(register()).rejects.toThrow('response lost');
		spy.mockRestore();
		const committed = await services.deepLinks.resolve('sales');
		expect(await register()).toEqual(committed);
		expect(await services.deepLinks.list(first)).toEqual([committed]);
		await expect(register(second)).rejects.toBeInstanceOf(ConflictError);
	});

	it('preserves ownership when release storage fails, then permits a retry', async () => {
		const link = await register();
		const put = bucket.put.bind(bucket);
		const spy = vi.spyOn(bucket, 'put').mockImplementation((key, value, options) => {
			if (key === paths.deepLink('sales')) throw new Error('storage unavailable');
			return put(key, value, options);
		});
		await expect(services.deepLinks.release('sales', first, link.registration_id)).rejects.toThrow(
			'storage unavailable',
		);
		expect(await services.deepLinks.resolve('sales')).toEqual(link);
		await expect(register(second)).rejects.toBeInstanceOf(ConflictError);
		spy.mockRestore();
		await services.deepLinks.release('sales', first, link.registration_id);
		await register(second);
	});

	it('stops after repeated registration CAS conflicts without claiming the name', async () => {
		const put = bucket.put.bind(bucket);
		const spy = vi.spyOn(bucket, 'put').mockImplementation((key, value, options) => {
			if (key === paths.deepLink('sales')) throw new PreconditionFailedError();
			return put(key, value, options);
		});
		await expect(register()).rejects.toThrow('Write conflict: max retries exceeded');
		expect(spy.mock.calls.filter(([key]) => key === paths.deepLink('sales'))).toHaveLength(5);
		expect(await bucket.get(paths.deepLink('sales'))).toBeNull();
		expect(await services.deepLinks.list(first)).toEqual([]);
	});

	it('checks every index page and excludes released or reassigned candidates', async () => {
		const released = await register(first, 'a');
		await services.deepLinks.release('a', first, released.registration_id);
		await register(second, 'a');
		const active = await register(first, 'b');
		await register(first, 'c');
		const list = bucket.list.bind(bucket);
		const spy = vi
			.spyOn(bucket, 'list')
			.mockImplementation((options) => list({ ...options, limit: 1 }));
		expect((await services.deepLinks.list(first)).map((link) => link.slug)).toEqual(['b', 'c']);
		expect(spy.mock.calls.some(([options]) => options?.cursor !== undefined)).toBe(true);
		await services.deepLinks.releaseNotebook(first.project_id, first.notebook_id);
		await expect(services.deepLinks.resolve(active.slug)).rejects.toBeInstanceOf(NotFoundError);
		await expect(services.deepLinks.resolve('c')).rejects.toBeInstanceOf(NotFoundError);
		expect((await services.deepLinks.resolve('a')).target).toEqual(second);
	});

	it.each(['notebook', 'project'] as const)(
		'retries failed %s cleanup before purging its reverse indexes',
		async (kind) => {
			const link = await register();
			const indexKey = paths
				.project(first.project_id)
				.notebook(first.notebook_id)
				.deepLinkIndex('sales');
			const put = bucket.put.bind(bucket);
			const spy = vi.spyOn(bucket, 'put').mockImplementation((key, value, options) => {
				if (key === paths.deepLink('sales')) throw new Error('release unavailable');
				return put(key, value, options);
			});
			if (kind === 'notebook')
				await services.notebooks.deleteNotebook(first.project_id, first.notebook_id, ACTOR);
			else await services.projects.deleteProject(first.project_id, ACTOR);
			const purge = () =>
				kind === 'notebook'
					? services.notebooks.hardDeleteNotebook(first.project_id, first.notebook_id)
					: services.projects.hardDeleteProject(first.project_id);
			await expect(purge()).rejects.toThrow('release unavailable');
			expect(await bucket.get(indexKey)).not.toBeNull();
			spy.mockRestore();
			await purge();
			expect(await bucket.get(indexKey)).toBeNull();
			const replacement = await register(second);
			await services.deepLinks.release('sales', first, link.registration_id);
			expect(await services.deepLinks.resolve('sales')).toEqual(replacement);
		},
	);

	it.each(['{invalid json', '{}', '{"schema_version":2}'])(
		'fails closed on a corrupt registry record %s',
		async (body) => {
			await register();
			await bucket.put(paths.deepLink('sales'), body);
			await expect(services.deepLinks.resolve('sales')).rejects.toThrow();
			await expect(register(second)).rejects.toThrow();
			expect(await (await bucket.get(paths.deepLink('sales')))!.text()).toBe(body);
		},
	);
});
