import { afterEach, expect, it, vi } from 'vitest';
import { SessionService, isReusableSession } from './SessionService';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { makeSession } from '../../testing';
import { createSandboxId } from '../../ids';
import { paths } from '../../paths';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const bucket = new MemoryBucket();
	const session = makeSession({ status: 'starting', sandbox_id: createSandboxId() });
	await bucket.put(paths.session(session.project_id, session.session_id), JSON.stringify(session));
	const writer = new SessionService(bucket);
	const reader = new SessionService(bucket);
	const completion = {
		id: crypto.randomUUID(),
		sandbox_id: session.sandbox_id!,
		ready_at: new Date().toISOString(),
		sandbox_url: 'https://runtime.test',
		sandbox_origin_url: 'http://runtime.internal',
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		reconnect_reference: 'runtime-reference',
	};
	return { bucket, session, writer, reader, completion };
}

it('recovers prepared runtime details on another replica with one running transition', async () => {
	const { session: s, writer, reader, completion } = await fixture();
	await writer.recordStartupCompletion(s.project_id, s.session_id, completion);
	const prepared = await reader.getSession(s.project_id, s.session_id);
	expect(prepared).toMatchObject({ status: 'starting', startup_completion: completion });
	expect(prepared.sandbox_url).toBeUndefined();
	const [first, second] = await Promise.all([
		reader.completeStartup(s.project_id, s.session_id, completion.id),
		writer.completeStartup(s.project_id, s.session_id, completion.id),
	]);
	expect(first.status).toBe('running');
	expect(second.status).toBe('running');
	expect(second.status_changed_at).toBe(first.status_changed_at);
	expect(first).toMatchObject({
		sandbox_url: completion.sandbox_url,
		sandbox_origin_url: completion.sandbox_origin_url,
		expires_at: completion.expires_at,
		reconnect_reference: completion.reconnect_reference,
	});
});

it.each(['terminate', 'markFailed', 'beginTerminating'] as const)(
	'never revives a session after %s',
	async (stop) => {
		const { session: s, writer, reader, completion } = await fixture();
		await writer.recordStartupCompletion(s.project_id, s.session_id, completion);
		await writer[stop](s.project_id, s.session_id);
		const before = await reader.getSession(s.project_id, s.session_id);
		await expect(
			reader.completeStartup(s.project_id, s.session_id, completion.id),
		).rejects.toThrow();
		expect(await reader.getSession(s.project_id, s.session_id)).toEqual(before);
	},
);

it('rejects stale completion after runtime replacement', async () => {
	const { session: s, writer, reader, completion } = await fixture();
	await writer.recordStartupCompletion(s.project_id, s.session_id, completion);
	await writer.replaceStartingSandbox(s.project_id, s.session_id, s.sandbox_id!, createSandboxId());
	await expect(reader.completeStartup(s.project_id, s.session_id, completion.id)).rejects.toThrow();
	await expect(
		writer.recordStartupCompletion(s.project_id, s.session_id, completion),
	).rejects.toThrow();
	expect((await reader.getSession(s.project_id, s.session_id)).startup_completion).toBeUndefined();
});

it('preserves the first receipt and rejects changed or expired runtime details', async () => {
	const { session: s, writer, reader, completion } = await fixture();
	await writer.recordStartupCompletion(s.project_id, s.session_id, completion);
	await expect(
		reader.recordStartupCompletion(s.project_id, s.session_id, {
			...completion,
			id: crypto.randomUUID(),
			sandbox_url: 'https://another.test',
		}),
	).rejects.toThrow();
	vi.spyOn(Date, 'now').mockReturnValue(Date.parse(completion.expires_at));
	await expect(reader.completeStartup(s.project_id, s.session_id, completion.id)).rejects.toThrow();
	expect((await reader.getSession(s.project_id, s.session_id)).status).toBe('starting');
});

it('an uncertain receipt failure cannot downgrade a recovered runtime', async () => {
	const { session: s, writer, reader, completion } = await fixture();
	await writer.recordStartupCompletion(s.project_id, s.session_id, completion);
	await reader.completeStartup(s.project_id, s.session_id, completion.id);
	expect(
		await writer.rejectStartupCompletion(
			s.project_id,
			s.session_id,
			{ sandbox_id: s.sandbox_id! },
			{ code: 'STORE_ERROR', message: 'Storage unavailable' },
		),
	).toBe(false);
	expect((await reader.getSession(s.project_id, s.session_id)).status).toBe('running');
});

it('replays the same completion receipt without replacing its immutable details', async () => {
	const { session: s, writer, reader, completion } = await fixture();
	await writer.recordStartupCompletion(s.project_id, s.session_id, completion);
	await reader.recordStartupCompletion(s.project_id, s.session_id, {
		...completion,
		sandbox_url: 'https://changed.test',
	});
	expect((await reader.getSession(s.project_id, s.session_id)).startup_completion).toEqual(
		completion,
	);
});

it('does not reject a replacement runtime from an old completion receipt', async () => {
	const { session: s, writer, reader, completion } = await fixture();
	await writer.recordStartupCompletion(s.project_id, s.session_id, completion);
	await writer.replaceStartingSandbox(s.project_id, s.session_id, s.sandbox_id!, createSandboxId());
	expect(
		await reader.rejectStartupCompletion(s.project_id, s.session_id, completion, {
			code: 'FORBIDDEN',
			message: 'Denied',
		}),
	).toBe(false);
	expect((await reader.getSession(s.project_id, s.session_id)).status).toBe('starting');
});

it('starts the retry grace at preparation without extending the runtime lifetime', async () => {
	const { bucket, session: s, writer, completion } = await fixture();
	const started = new Date(Date.parse(completion.ready_at) - 4 * 60_000).toISOString();
	await bucket.put(
		paths.session(s.project_id, s.session_id),
		JSON.stringify({ ...s, started_at: started, last_heartbeat: started }),
	);
	const prepared = await writer.recordStartupCompletion(s.project_id, s.session_id, completion);
	expect(prepared.last_heartbeat).toBe(completion.ready_at);
	expect(isReusableSession(prepared, Date.parse(completion.ready_at) + 2 * 60_000)).toBe(true);
	expect(isReusableSession(prepared, Date.parse(completion.ready_at) + 5 * 60_000)).toBe(false);
	expect(prepared.startup_completion?.expires_at).toBe(completion.expires_at);
});

it('a completed runtime keeps a subsequent lifetime extension on repeated completion', async () => {
	const { session: s, writer, reader, completion } = await fixture();
	await writer.recordStartupCompletion(s.project_id, s.session_id, completion);
	await reader.completeStartup(s.project_id, s.session_id, completion.id);
	const extended = new Date(Date.parse(completion.expires_at) + 60_000).toISOString();
	await writer.extendExpiry(s.project_id, s.session_id, extended);
	vi.spyOn(Date, 'now').mockReturnValue(Date.parse(completion.expires_at));
	expect((await reader.completeStartup(s.project_id, s.session_id, completion.id)).expires_at).toBe(
		extended,
	);
	expect(
		await reader.rejectStartupCompletion(
			s.project_id,
			s.session_id,
			{ ...completion, status: 'starting' },
			{ code: 'CONFLICT', message: 'Expired' },
		),
	).toBe(false);
	expect((await writer.getSession(s.project_id, s.session_id)).status).toBe('running');
});
