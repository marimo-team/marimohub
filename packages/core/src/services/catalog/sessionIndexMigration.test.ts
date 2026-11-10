import { afterEach, expect, it, vi } from 'vitest';
import { ACTOR, uid } from '../../testing';
import { legacySessions } from '../../testing/legacy-sessions';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { createNotebookId, createProjectId, SandboxId } from '../../ids';
import { paths } from '../../paths';
import { createServices } from '../index';
import { SessionIndex } from '../runtime/SessionIndex';
import { SESSION_INDEX_MIGRATION } from './migrations';

const receipt = paths.migration(SESSION_INDEX_MIGRATION);
afterEach(() => vi.restoreAllMocks());

async function fixture(count = 1) {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	await services.catalog.initialize(ACTOR);
	const input = { project_id: createProjectId(), notebook_id: createNotebookId(), user_id: ACTOR };
	const legacy = legacySessions(bucket);
	const records = await Promise.all(
		Array.from({ length: count }, () => legacy.createSession(input)),
	);
	return { bucket, services, input, records, legacy, index: new SessionIndex(bucket) };
}

async function finish(services: ReturnType<typeof createServices>) {
	for (let i = 0; i < 10; i++) if (await services.migrations.tick()) return;
	throw new Error('Migration did not finish');
}

it('runs after project access, backfills once, and activates cold replicas without request-time receipt reads', async () => {
	const { bucket, services, records, index } = await fixture();
	expect(await services.migrations.tick()).toBe(false);
	expect(await bucket.get(receipt)).toBeNull();
	expect(await services.sessions.countActiveForUser(ACTOR)).toBe(1);
	expect(await services.migrations.tick()).toBe(true);
	expect((await index.read(ACTOR))?.entries).toEqual([
		{ project_id: records[0].project_id, session_id: records[0].session_id },
	]);
	const cold = createServices(bucket);
	const list = vi.spyOn(bucket, 'list');
	expect(await cold.migrations.tick()).toBe(true);
	expect(list).not.toHaveBeenCalled();
	const get = vi.spyOn(bucket, 'get');
	const put = vi.spyOn(bucket, 'put');
	for (let i = 0; i < 3; i++) {
		expect(await cold.sessions.countActiveForUser(ACTOR)).toBe(1);
		expect(await cold.migrations.tick()).toBe(true);
	}
	expect(list).not.toHaveBeenCalled();
	expect(put).not.toHaveBeenCalled();
	expect(get.mock.calls.some(([key]) => key.startsWith('_system/migrations/'))).toBe(false);
});

it('bounds history traversal, keeps partial indexes untrusted, and resumes after restart', async () => {
	const { bucket, services, index } = await fixture(105);
	await services.migrations.tick();
	const list = vi.spyOn(bucket, 'list');
	expect(await services.migrations.tick()).toBe(false);
	expect(list).toHaveBeenCalledExactlyOnceWith({
		prefix: paths.sessionsPrefix,
		cursor: undefined,
		limit: 100,
	});
	expect((await index.read(ACTOR))?.entries).toHaveLength(100);
	expect(await services.sessions.countActiveForUser(ACTOR)).toBe(105);
	list.mockClear();
	const cold = createServices(bucket);
	expect(await cold.migrations.tick()).toBe(true);
	expect(list).toHaveBeenCalledTimes(1);
	expect((await index.read(ACTOR))?.entries).toHaveLength(105);
	expect(await cold.sessions.countActiveForUser(ACTOR)).toBe(105);
});

it.each([
	'corrupt-session',
	'wrong-source',
	'corrupt-index',
	'wrong-owner',
	'read-failure',
	'write-failure',
	'lost-response',
])('keeps failed work retryable and scans authoritative records after %s', async (failure) => {
	const { bucket, services, records } = await fixture();
	await services.migrations.tick();
	const session = records[0];
	const key = paths.session(session.project_id, session.session_id);
	const indexKey = paths.sessionIndexForUser(ACTOR);
	if (failure === 'corrupt-session') await bucket.put(key, '{');
	if (failure === 'wrong-source')
		await bucket.put(key, JSON.stringify({ ...session, project_id: createProjectId() }));
	if (failure === 'corrupt-index') await bucket.put(indexKey, '{');
	if (failure === 'wrong-owner')
		await bucket.put(indexKey, JSON.stringify({ user_id: uid('other'), entries: [] }));
	const get = bucket.get.bind(bucket);
	const put = bucket.put.bind(bucket);
	vi.spyOn(bucket, 'get').mockImplementation((path, ...args) => {
		if (failure === 'read-failure' && path === key) throw new Error('read unavailable');
		return get(path, ...args);
	});
	vi.spyOn(bucket, 'put').mockImplementation(async (path, ...args) => {
		if (path === indexKey) {
			if (failure === 'write-failure') throw new Error('write unavailable');
			if (failure === 'lost-response') {
				await put(path, ...args);
				throw new Error('response lost');
			}
		}
		return put(path, ...args);
	});
	await expect(services.migrations.tick()).rejects.toThrow();
	expect(services.migrations.isComplete(SESSION_INDEX_MIGRATION)).toBe(false);
	expect(await (await bucket.get(receipt))!.json()).toEqual({ version: 1, status: 'pending' });
	vi.restoreAllMocks();
	await bucket.put(key, JSON.stringify(session));
	await bucket.delete(indexKey);
	expect(await services.sessions.countActiveForUser(ACTOR)).toBe(1);
	await finish(createServices(bucket));
	expect(await (await bucket.get(receipt))!.json()).toMatchObject({ status: 'complete' });
});

it('retains unreclaimed apps but excludes terminal editors and reclaimed apps', async () => {
	const { bucket, services, input, legacy, index } = await fixture(0);
	const editor = await legacy.createSession(input);
	const app = await legacy.createSession({
		...input,
		mode: 'app',
		sandbox_id: SandboxId.parse('sb-0000000000000001'),
	});
	const reclaimed = await legacy.createSession({
		...input,
		mode: 'app',
		sandbox_id: SandboxId.parse('sb-0000000000000002'),
	});
	for (const session of [editor, app, reclaimed])
		await bucket.put(
			paths.session(session.project_id, session.session_id),
			JSON.stringify({
				...session,
				status: 'failed',
				...(session === reclaimed ? { sandbox_reclaimed_at: new Date().toISOString() } : {}),
			}),
		);
	await finish(services);
	expect((await index.read(ACTOR))?.entries.map((entry) => entry.session_id)).toEqual([
		app.session_id,
	]);
	expect(await services.sessions.countActiveForUser(ACTOR)).toBe(0);
	expect(await services.sessions.countActiveForUser(ACTOR, 'project')).toBe(1);
});

it.each(['terminate', 'register', 'delete'] as const)(
	'preserves a concurrent %s during index publication',
	async (action) => {
		const { bucket, services, input, records, index } = await fixture();
		await services.migrations.tick();
		const put = bucket.put.bind(bucket);
		let raced = false;
		let createdId = '';
		vi.spyOn(bucket, 'put').mockImplementation(async (key, ...args) => {
			if (key === paths.sessionIndexForUser(ACTOR) && !raced) {
				raced = true;
				if (action === 'terminate')
					await services.sessions.markFailed(input.project_id, records[0].session_id);
				if (action === 'register')
					createdId = (await services.sessions.createSession(input)).session_id;
				if (action === 'delete')
					await bucket.delete(paths.session(input.project_id, records[0].session_id));
			}
			return put(key, ...args);
		});
		await finish(services);
		// Reads validate references even if deletion committed without an index CAS.
		const active = await services.sessions.listActiveForUser(ACTOR);
		expect(active.map((s) => s.session_id).sort()).toEqual(
			action === 'register' ? [records[0].session_id, createdId].sort() : [],
		);
		expect((await index.read(ACTOR))?.entries).toHaveLength(action === 'register' ? 2 : 0);
	},
);

it('skips a record deleted between listing and reading', async () => {
	const { bucket, services, records } = await fixture();
	await services.migrations.tick();
	const list = bucket.list.bind(bucket);
	vi.spyOn(bucket, 'list').mockImplementationOnce(async (options) => {
		const page = await list(options);
		await bucket.delete(paths.session(records[0].project_id, records[0].session_id));
		return page;
	});
	expect(await services.migrations.tick()).toBe(true);
});

it('does not treat a lost index as an empty queue after migration', async () => {
	const { bucket, services } = await fixture(2);
	await finish(services);
	await bucket.delete(paths.sessionIndexForUser(ACTOR));
	expect(await services.sessions.countActiveForUser(ACTOR)).toBe(2);
});

it('cancels during a session read without publishing an index or completion', async () => {
	const { bucket, services, records, index } = await fixture();
	await services.migrations.tick();
	const controller = new AbortController();
	const key = paths.session(records[0].project_id, records[0].session_id);
	const get = bucket.get.bind(bucket);
	const spy = vi.spyOn(bucket, 'get').mockImplementation(async (path, ...args) => {
		const object = await get(path, ...args);
		if (path === key) controller.abort(new Error('shutdown'));
		return object;
	});
	await expect(services.migrations.tick(controller.signal)).rejects.toThrow('shutdown');
	expect(await index.read(ACTOR)).toBeNull();
	expect(await (await bucket.get(receipt))!.json()).toEqual({ version: 1, status: 'pending' });
	spy.mockRestore();
	expect(await createServices(bucket).migrations.tick()).toBe(true);
});
