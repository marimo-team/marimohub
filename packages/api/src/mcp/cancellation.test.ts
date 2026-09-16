import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectMcpClient, createMcpSession, mcpPrincipal } from '../testing/mcp';

const requestContext = {
	method: 'POST',
	path: '/mcp',
	hostname: 'hub.example.com',
	appBaseUrl: 'https://hub.example.com',
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('MCP session cancellation', () => {
	it.each(['create_notebook', 'start_session', 'execute_code'])(
		'does not start work for an already cancelled %s request',
		async (name) => {
			const { deps, project, session } = await createMcpSession();
			const create = vi.spyOn(deps.services.notebooks, 'createNotebook');
			const heartbeat = vi.spyOn(deps.services.sessions, 'heartbeat');
			const proxy = vi.spyOn(deps.compute, 'proxy');
			const client = await connectMcpClient(deps, mcpPrincipal, {
				...requestContext,
				signal: AbortSignal.abort(),
			});
			expect(
				await client.callTool({
					name,
					arguments: {
						project: project.id,
						notebook: session.notebook_id,
						session_id: session.session_id,
						title: 'Cancelled',
						code: 'side_effect()',
						launch: true,
					},
				}),
			).toMatchObject({ isError: true, structuredContent: { code: 'REQUEST_CANCELLED' } });
			expect(create).not.toHaveBeenCalled();
			expect(heartbeat).not.toHaveBeenCalled();
			expect(proxy).not.toHaveBeenCalled();
		},
	);

	it.each(['disconnect', 'notification'])(
		'stops kernel discovery and heartbeats after a cancellation %s',
		async (source) => {
			vi.useFakeTimers();
			const { deps, project, session } = await createMcpSession();
			const controller = new AbortController();
			const heartbeat = vi.spyOn(deps.services.sessions, 'heartbeat');
			const proxy = vi.spyOn(deps.compute, 'proxy').mockImplementation(() => new Promise(() => {}));
			const client = await connectMcpClient(deps, mcpPrincipal, {
				...requestContext,
				...(source === 'disconnect' ? { signal: controller.signal } : {}),
			});
			const pending = client.callTool(
				{
					name: 'execute_code',
					arguments: { project: project.id, session_id: session.session_id, code: 'side_effect()' },
				},
				undefined,
				source === 'notification' ? { signal: controller.signal } : undefined,
			);
			const settled = pending.catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(0);
			expect(proxy).toHaveBeenCalledOnce();
			controller.abort();
			if (source === 'disconnect') {
				expect(await settled).toMatchObject({
					isError: true,
					structuredContent: { code: 'REQUEST_CANCELLED' },
				});
			} else {
				await settled;
			}
			await vi.advanceTimersByTimeAsync(60_000);
			expect(proxy.mock.calls[0][0].signal.aborted).toBe(true);
			expect(proxy).toHaveBeenCalledOnce();
			expect(heartbeat).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
