import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpSession, mcpPrincipal as principal } from '../testing/mcp';
import { withMcpSessionActivity } from './sessionActivity';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('MCP session activity', () => {
	it('heartbeats long requests, stops on completion, then permits idle cleanup', async () => {
		vi.useFakeTimers();
		const { deps, project, session } = await createMcpSession();
		const heartbeat = vi.spyOn(deps.services.sessions, 'heartbeat');
		let finish!: () => void;
		const pending = withMcpSessionActivity(
			deps,
			principal,
			project,
			session,
			async () =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		await vi.advanceTimersByTimeAsync(6 * 60_000);
		expect(heartbeat).toHaveBeenCalledTimes(13);
		expect(await deps.services.sessions.expireStale()).toBe(0);
		finish();
		await pending;
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(6 * 60_000);
		expect(heartbeat).toHaveBeenCalledTimes(13);
		expect(await deps.services.sessions.expireStale()).toBe(1);
	});
	it.each(['session', 'credential'] as const)('aborts at %s authorization expiry', async (kind) => {
		vi.useFakeTimers();
		const expiresAt = new Date(Date.now() + 45_000).toISOString();
		const { deps, project, session } = await createMcpSession(
			kind === 'session' ? expiresAt : undefined,
		);
		const user =
			kind === 'credential'
				? { ...principal, credential: { ...principal.credential, expiresAt } }
				: principal;
		let signal: AbortSignal | undefined;
		const pending = withMcpSessionActivity(deps, user, project, session, async (value) => {
			signal = value;
			return new Promise(() => {});
		});
		const rejected = expect(pending).rejects.toThrow('authorization has expired');
		await vi.advanceTimersByTimeAsync(45_000);
		await rejected;
		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('does not revive a session stopped during execution', async () => {
		vi.useFakeTimers();
		const { deps, project, session } = await createMcpSession();
		let signal: AbortSignal | undefined;
		const pending = withMcpSessionActivity(deps, principal, project, session, async (value) => {
			signal = value;
			return new Promise(() => {});
		});
		const rejected = expect(pending).rejects.toThrow('no longer running');
		await vi.advanceTimersByTimeAsync(1);
		await deps.services.sessions.beginTerminating(project.id, session.session_id);
		await vi.advanceTimersByTimeAsync(30_000);
		await rejected;
		expect(signal?.aborted).toBe(true);
		expect((await deps.services.sessions.getSession(project.id, session.session_id)).status).toBe(
			'terminating',
		);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('finishes while a heartbeat is in flight without leaving timers behind', async () => {
		vi.useFakeTimers();
		const { deps, project, session } = await createMcpSession();
		let releaseHeartbeat!: () => void;
		vi.spyOn(deps.services.sessions, 'heartbeat')
			.mockResolvedValueOnce(session)
			.mockImplementation(async () => {
				await new Promise<void>((resolve) => {
					releaseHeartbeat = resolve;
				});
				return session;
			});
		let finish!: () => void;
		const pending = withMcpSessionActivity(
			deps,
			principal,
			project,
			session,
			async () =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		await vi.advanceTimersByTimeAsync(30_000);
		finish();
		await pending;
		expect(vi.getTimerCount()).toBe(0);
		releaseHeartbeat();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('clears timers and aborts work when heartbeat storage fails', async () => {
		vi.useFakeTimers();
		const { deps, project, session } = await createMcpSession();
		vi.spyOn(deps.services.sessions, 'heartbeat')
			.mockResolvedValueOnce(session)
			.mockRejectedValueOnce(new Error('storage failed'));
		const pending = withMcpSessionActivity(
			deps,
			principal,
			project,
			session,
			async () => new Promise(() => {}),
		);
		const assertion = expect(pending).rejects.toThrow('storage failed');
		await vi.advanceTimersByTimeAsync(30_000);
		await assertion;
		expect(vi.getTimerCount()).toBe(0);
	});

	it('honors credential expiry while initial authorization is stalled', async () => {
		vi.useFakeTimers();
		const { deps, project, session } = await createMcpSession();
		vi.spyOn(deps.services.sessions, 'getSession').mockImplementation(() => new Promise(() => {}));
		const work = vi.fn();
		const user = {
			...principal,
			credential: { ...principal.credential, expiresAt: new Date(Date.now() + 100).toISOString() },
		};
		const pending = withMcpSessionActivity(deps, user, project, session, work);
		const assertion = expect(pending).rejects.toThrow('authorization has expired');
		await vi.advanceTimersByTimeAsync(100);
		await assertion;
		expect(work).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['', 'invalid', '2000-01-01T00:00:00Z'])(
		'rejects invalid or expired credential deadlines: %j',
		async (expiresAt) => {
			const { deps, project, session } = await createMcpSession();
			const work = vi.fn();
			const heartbeat = vi.spyOn(deps.services.sessions, 'heartbeat');
			await expect(
				withMcpSessionActivity(
					deps,
					{ ...principal, credential: { ...principal.credential, expiresAt } },
					project,
					session,
					work,
				),
			).rejects.toThrow('authorization has expired');
			expect(work).not.toHaveBeenCalled();
			expect(heartbeat).not.toHaveBeenCalled();
		},
	);

	it('cleans timers after work fails', async () => {
		vi.useFakeTimers();
		const { deps, project, session } = await createMcpSession();
		await expect(
			withMcpSessionActivity(deps, principal, project, session, async () => {
				throw new Error('failed');
			}),
		).rejects.toThrow('failed');
		expect(vi.getTimerCount()).toBe(0);
	});
	it('does not heartbeat or call work for unauthorized callers', async () => {
		const { deps, project, session } = await createMcpSession();
		const heartbeat = vi.spyOn(deps.services.sessions, 'heartbeat');
		const work = vi.fn();
		const user = {
			...principal,
			credential: {
				kind: 'personal-access-token' as const,
				grant: { actions: ['project.read' as const], projects: '*' as const },
			},
		};
		await expect(withMcpSessionActivity(deps, user, project, session, work)).rejects.toThrow();
		expect(heartbeat).not.toHaveBeenCalled();
		expect(work).not.toHaveBeenCalled();
	});
});
