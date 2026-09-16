import { describe, expect, it, vi } from 'vitest';
import { connectMcpClient, createMcpSession, mcpPrincipal as principal } from '../testing/mcp';

const completed = () =>
	new Response('event: stdout\ndata: {"data":"42\\n"}\n\nevent: done\ndata: {"success":true}\n\n', {
		headers: { 'content-type': 'text/event-stream' },
	});
async function setup(proxy: (request: Request) => Promise<Response>, expiresAt?: string) {
	const create = vi.fn(() => {
		throw new Error('Execution must not bootstrap a kernel');
	});
	const { deps, project, session } = await createMcpSession(expiresAt, {
		compute: { create, proxy },
	});
	const client = await connectMcpClient(deps, principal);
	return {
		create,
		run: () =>
			client.callTool({
				name: 'execute_code',
				arguments: { project: project.id, session_id: session.session_id, code: 'print(42)' },
			}),
	};
}

describe('MCP execution kernel discovery', () => {
	it('rediscovers on every call and retries only the rejected stale session ID', async () => {
		const requests: Request[] = [];
		let id = 'headless';
		const proxy = vi.fn(async (request: Request) => {
			requests.push(request);
			if (request.method === 'GET') return Response.json({ [id]: {} });
			if (request.headers.get('Marimo-Session-Id') === 'headless') {
				id = 'browser';
				return Response.json({ detail: 'Invalid session id: headless' }, { status: 500 });
			}
			return completed();
		});
		const { run, create } = await setup(proxy);
		expect(await run()).toMatchObject({
			structuredContent: { kernel_session_id: 'browser', success: true, stdout: '42\n' },
		});
		id = 'another-browser';
		expect(await run()).toMatchObject({
			structuredContent: { kernel_session_id: 'another-browser', success: true },
		});
		expect(requests.map((request) => request.method)).toEqual([
			'GET',
			'POST',
			'GET',
			'POST',
			'GET',
			'POST',
		]);
		expect(create).not.toHaveBeenCalled();
	});
	it.each(['server error', 'network error', 'partial stream', 'wrong session'])(
		'does not replay code after %s',
		async (failure) => {
			const proxy = vi.fn(async (request: Request) => {
				if (request.method === 'GET') return Response.json({ kernel: {} });
				if (failure === 'network error') throw new Error('Disconnected');
				if (failure === 'partial stream')
					return new Response('event: stdout\ndata: {"data":"started"}\n\n', {
						headers: { 'content-type': 'text/event-stream' },
					});
				return Response.json(
					{
						detail:
							failure === 'wrong session'
								? 'Invalid session id: someone-else'
								: 'Failed after dispatch',
					},
					{ status: 500 },
				);
			});
			const { run } = await setup(proxy);
			expect(await run()).toMatchObject({ isError: true });
			expect(proxy).toHaveBeenCalledTimes(2);
		},
	);
	it('retries discovery only once when browser attachments keep racing', async () => {
		let count = 0;
		const proxy = vi.fn(async (request: Request) => {
			if (request.method === 'GET') return Response.json({ [`kernel-${++count}`]: {} });
			return Response.json(
				{ detail: `Invalid session id: ${request.headers.get('Marimo-Session-Id')}` },
				{ status: 500 },
			);
		});
		const { run } = await setup(proxy);
		expect(await run()).toMatchObject({ isError: true });
		expect(proxy).toHaveBeenCalledTimes(4);
	});
	it('directs missing kernels to start_session without silently recreating state', async () => {
		const proxy = vi.fn(async () => Response.json({}));
		const { run, create } = await setup(proxy);
		expect(await run()).toMatchObject({
			isError: true,
			structuredContent: {
				code: 'NO_KERNEL_SESSION',
				message: expect.stringContaining('Call start_session'),
			},
		});
		expect(proxy).toHaveBeenCalledOnce();
		expect(create).not.toHaveBeenCalled();
	});
	it('rejects expired session authorization before contacting the kernel', async () => {
		const proxy = vi.fn(async () => completed());
		const { run } = await setup(proxy, '2000-01-01T00:00:00.000Z');
		expect(await run()).toMatchObject({
			isError: true,
			structuredContent: { code: 'BAD_REQUEST' },
		});
		expect(proxy).not.toHaveBeenCalled();
	});
});
