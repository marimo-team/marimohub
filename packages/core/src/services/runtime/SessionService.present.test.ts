import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId } from '../../ids';
import { paths } from '../../paths';
import type { Session } from '../../schema';
import { ACTOR, MemoryBucket, uid } from '../../testing';
import { legacySessions } from '../../testing/legacy-sessions';
import { SessionService } from './SessionService';

const OTHER = uid('other');
afterEach(() => vi.restoreAllMocks());

function fixture(ready = true) {
	const bucket = new MemoryBucket();
	const writer = new SessionService(bucket, undefined, undefined, () => ready);
	const input = { project_id: createProjectId(), notebook_id: createNotebookId(), user_id: ACTOR };
	const reader = () => new SessionService(bucket, undefined, undefined, () => ready);
	return { bucket, writer, input, reader };
}

async function replace(bucket: MemoryBucket, session: Session, changes: Partial<Session>) {
	await bucket.put(
		paths.session(session.project_id, session.session_id),
		JSON.stringify({ ...session, ...changes }),
	);
}

describe('present sessions for a user in a project', () => {
	it('reads only current references on a cold replica, including apps and terminating sessions', async () => {
		const { bucket, writer, input, reader } = fixture();
		const editor = await writer.createSession(input);
		await writer.setRunning(input.project_id, editor.session_id, 'https://kernel.example');
		const app = await writer.createSession({ ...input, mode: 'app' });
		const stopping = await writer.createSession(input);
		await writer.beginTerminating(input.project_id, stopping.session_id);
		for (let i = 0; i < 10; i++) {
			const old = await writer.createSession(input);
			await writer.terminate(input.project_id, old.session_id);
		}
		await writer.createSession({ ...input, user_id: OTHER });
		await writer.createSession({ ...input, project_id: createProjectId() });
		const get = vi.spyOn(bucket, 'get');
		const list = vi.spyOn(bucket, 'list');
		const current = await reader().listPresentForUser(ACTOR, input.project_id);
		expect(current.map((session) => session.session_id).sort()).toEqual(
			[editor, app, stopping].map((session) => session.session_id).sort(),
		);
		expect(list).not.toHaveBeenCalled();
		expect(get.mock.calls.map(([key]) => key).sort()).toEqual(
			[
				paths.sessionIndexForUser(ACTOR),
				...[editor, app, stopping].map((session) =>
					paths.session(input.project_id, session.session_id),
				),
			].sort(),
		);
	});

	it('revalidates references and observes new registrations without returning missing or terminal records', async () => {
		const { bucket, writer, input, reader } = fixture();
		const gone = await writer.createSession(input);
		const terminal = await writer.createSession({
			...input,
			mode: 'app',
			sandbox_id: createSandboxId(),
		});
		const cold = reader();
		expect(await cold.listPresentForUser(ACTOR, input.project_id)).toHaveLength(2);
		await bucket.delete(paths.session(input.project_id, gone.session_id));
		await replace(bucket, terminal, { status: 'failed' });
		const added = await writer.createSession(input);
		expect(await cold.listPresentForUser(ACTOR, input.project_id)).toEqual([added]);
	});

	it.each(['missing', 'incomplete'] as const)(
		'scans only the project when the index is %s',
		async (state) => {
			const { bucket, writer, input } = fixture(state === 'missing');
			await writer.createSession({ ...input, user_id: OTHER });
			const own = await legacySessions(bucket).createSession(input);
			await bucket.put(
				paths.sessionIndexForUser(ACTOR),
				JSON.stringify({ user_id: ACTOR, entries: [] }),
			);
			if (state === 'missing') await bucket.delete(paths.sessionIndexForUser(ACTOR));
			const list = vi.spyOn(bucket, 'list');
			const reader = new SessionService(bucket, undefined, undefined, () => state === 'missing');
			expect(await reader.listPresentForUser(ACTOR, input.project_id)).toEqual([own]);
			expect(list).toHaveBeenCalled();
			expect(
				list.mock.calls.every(
					([options]) => options?.prefix === paths.sessionsForProject(input.project_id),
				),
			).toBe(true);
		},
	);

	it.each(['owner', 'project', 'session'] as const)(
		'falls back to the project scan when an indexed record has the wrong %s',
		async (field) => {
			const { bucket, writer, input, reader } = fixture();
			const session = await writer.createSession(input);
			const other = await writer.createSession(input);
			await replace(bucket, session, {
				...(field === 'owner' ? { user_id: OTHER } : {}),
				...(field === 'project' ? { project_id: createProjectId() } : {}),
				...(field === 'session' ? { session_id: other.session_id } : {}),
			});
			const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
			const list = vi.spyOn(bucket, 'list');
			const present = await reader().listPresentForUser(ACTOR, input.project_id);
			expect(present.map((s) => s.session_id)).toContain(other.session_id);
			expect(present.every((s) => s.user_id === ACTOR)).toBe(true);
			expect(list).toHaveBeenCalled();
			expect(logged.mock.calls.flat().join(' ')).toContain('session_index_mismatch');
		},
	);

	it.each(['index-owner', 'index-json', 'record-json'] as const)(
		'rejects %s corruption instead of accepting an empty result',
		async (corruption) => {
			const { bucket, writer, input, reader } = fixture();
			const session = await writer.createSession(input);
			const key =
				corruption === 'record-json'
					? paths.session(input.project_id, session.session_id)
					: paths.sessionIndexForUser(ACTOR);
			await bucket.put(
				key,
				corruption === 'index-owner' ? JSON.stringify({ user_id: OTHER, entries: [] }) : 'not JSON',
			);
			await expect(reader().listPresentForUser(ACTOR, input.project_id)).rejects.toThrow();
		},
	);

	it.each(['index', 'record', 'fallback-list'] as const)(
		'propagates %s storage failures',
		async (failure) => {
			const { bucket, writer, input } = fixture();
			const session = await writer.createSession(input);
			const key =
				failure === 'index'
					? paths.sessionIndexForUser(ACTOR)
					: paths.session(input.project_id, session.session_id);
			if (failure === 'fallback-list')
				vi.spyOn(bucket, 'list').mockRejectedValue(new Error('unavailable'));
			else {
				const get = bucket.get.bind(bucket);
				vi.spyOn(bucket, 'get').mockImplementation((path, options) => {
					if (path === key) throw new Error('unavailable');
					return get(path, options);
				});
			}
			const reader = new SessionService(
				bucket,
				undefined,
				undefined,
				() => failure !== 'fallback-list',
			);
			await expect(reader.listPresentForUser(ACTOR, input.project_id)).rejects.toThrow(
				'unavailable',
			);
		},
	);
});

describe('indexed temporary editor reuse', () => {
	it('preserves newest-heartbeat selection and project-list tie order regardless of index order', async () => {
		const { bucket, writer, input, reader } = fixture();
		const first = await writer.createSession({ ...input, ephemeral: true });
		const second = await writer.createSession({ ...input, ephemeral: true });
		const heartbeat = new Date().toISOString();
		for (const session of [first, second])
			await replace(bucket, session, { last_heartbeat: heartbeat });
		const ids = [first, second].sort((a, b) => a.session_id.localeCompare(b.session_id));
		await bucket.put(
			paths.sessionIndexForUser(ACTOR),
			JSON.stringify({
				user_id: ACTOR,
				entries: ids.toReversed().map(({ session_id, project_id }) => ({ session_id, project_id })),
			}),
		);
		const cold = reader();
		const list = vi.spyOn(bucket, 'list');
		const find = () =>
			cold.findReusableEditor(input.project_id, input.notebook_id, ACTOR, 'exclusive', true);
		expect((await find()).session?.session_id).toBe(ids[0].session_id);
		await replace(bucket, ids[1], { last_heartbeat: new Date(Date.now() + 1000).toISOString() });
		expect((await find()).session?.session_id).toBe(ids[1].session_id);
		expect(list).not.toHaveBeenCalled();
	});

	it('excludes other owners, projects, notebooks, persistent editors, apps and stopping sessions', async () => {
		const { writer, input, reader } = fixture();
		await writer.createSession(input);
		await writer.createSession({ ...input, ephemeral: true, user_id: OTHER });
		await writer.createSession({ ...input, ephemeral: true, project_id: createProjectId() });
		await writer.createSession({ ...input, ephemeral: true, notebook_id: createNotebookId() });
		await writer.createSession({ ...input, mode: 'app' });
		const stopping = await writer.createSession({ ...input, ephemeral: true });
		await writer.beginTerminating(input.project_id, stopping.session_id);
		expect(
			await reader().findReusableEditor(input.project_id, input.notebook_id, ACTOR, 'shared', true),
		).toEqual({ sharing: 'shared', session: undefined });
	});

	it('keeps pending starts reusable only within the existing startup deadline', async () => {
		const { bucket, writer, input, reader } = fixture();
		const starting = await writer.createSession({ ...input, ephemeral: true });
		const cold = reader();
		const find = () =>
			cold.findReusableEditor(input.project_id, input.notebook_id, ACTOR, 'exclusive', true);
		expect((await find()).session?.session_id).toBe(starting.session_id);
		await replace(bucket, starting, { started_at: '2000-01-01T00:00:00.000Z' });
		expect((await find()).session).toBeUndefined();
	});

	it('retains cross-owner persistent adoption when no editor claim exists', async () => {
		const { writer, input, reader } = fixture();
		const owner = await writer.createSession({
			...input,
			user_id: OTHER,
			editor_sandbox_sharing: 'shared',
		});
		const found = await reader().findReusableEditor(
			input.project_id,
			input.notebook_id,
			ACTOR,
			'shared',
			false,
		);
		expect(found.session?.session_id).toBe(owner.session_id);
	});
});
