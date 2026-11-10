import { createSandboxClient } from '@coreweave/cwsandbox/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function nativeClient(mode: 'auto' | 'direct' | 'gateway' = 'direct') {
	const client = createSandboxClient({ apiKey: 'test-key', dataPlaneMode: mode });
	const response = { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
	const rpc = {
		exec: vi.fn(() => ({ response: Promise.resolve(response) })),
		writeFile: vi.fn(() => ({ response: Promise.resolve({}) })),
		readFile: vi.fn(() => ({
			response: Promise.resolve({ content: new TextEncoder().encode('content') }),
		})),
	};
	const close = vi.fn();
	const channelFactory = vi.fn(() => ({ client: rpc, ready: Promise.resolve(), close }));
	const issue = vi.fn(async (id: string, permission: number) => ({
		cacheKey: `${id}:${permission}`,
		expiresAtMs: Date.now() + 120_000,
		grantedPermissions: new Set([permission]),
	}));
	// Inject only credential issuance/channel I/O; exercise the installed SDK's cache and public API.
	const native = client as unknown as {
		transport: {
			get: (request: unknown) => Promise<unknown>;
			directDataPlane: {
				stateFor: (id: string) => { retryAtMs: number };
				acquire: (options: {
					sandboxId: string;
					permission: number;
					dataPlaneMode: string;
				}) => Promise<unknown>;
				issueCredential: typeof issue;
				pool: {
					constructor: new (
						limit: number,
						factory: typeof channelFactory,
					) => {
						acquire: (
							bundle: unknown,
							timeoutMs: number,
							signal?: AbortSignal,
						) => Promise<{ client: typeof rpc; release: () => Promise<void> }>;
						release: (key: string, entry: unknown, discard: boolean) => void;
					};
				};
			};
		};
	};
	native.transport.directDataPlane.issueCredential = issue;
	const Pool = native.transport.directDataPlane.pool.constructor;
	const pool = new Pool(64, channelFactory);
	const acquire = vi.spyOn(pool, 'acquire');
	const release = vi.spyOn(pool, 'release');
	native.transport.directDataPlane.pool =
		pool as unknown as typeof native.transport.directDataPlane.pool;
	native.transport.get = async () => ({
		sandboxId: 'sandbox',
		metadata: { sandboxId: 'sandbox', status: 'running' },
	});
	return {
		client,
		issue,
		acquire,
		release,
		rpc,
		channelFactory,
		close,
		dataPlane: native.transport.directDataPlane,
	};
}

describe('installed SDK preconnect extension', () => {
	it('warms each permission without runner operations, then reuses credentials for real exec/read/write calls', async () => {
		vi.useFakeTimers();
		const { client, issue, release, rpc, dataPlane, channelFactory } = nativeClient();
		dataPlane.stateFor('sandbox').retryAtMs = Date.now() + 30_000;
		const cooldown = dataPlane.stateFor('sandbox').retryAtMs;
		expect(await client.preconnect('sandbox')).toBe(true);
		expect(issue.mock.calls.map((args) => args[1])).toEqual([1, 2, 3, 4, 5]);
		expect(dataPlane.stateFor('sandbox').retryAtMs).toBe(cooldown);
		expect(release).toHaveBeenCalledTimes(5);
		for (const call of Object.values(rpc)) expect(call).not.toHaveBeenCalled();
		const sandbox = await client.fromId('sandbox');
		await sandbox.commands.run(['true']);
		await sandbox.files.write([{ path: '/tmp/file', content: 'content' }]);
		expect(await sandbox.files.readText('/tmp/file')).toBe('content');
		expect(issue).toHaveBeenCalledTimes(5);
		expect(release).toHaveBeenCalledTimes(8);
		expect(channelFactory).toHaveBeenCalledTimes(5);
		expect(await client.preconnect('sandbox')).toBe(true);
		expect(issue).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(65_000);
		expect(await client.preconnect('sandbox')).toBe(true);
		expect(issue).toHaveBeenCalledTimes(10);
	});

	it('enforces a shared deadline while a real channel is pending and discards it', async () => {
		vi.useFakeTimers();
		const { client, acquire, release, channelFactory, close, rpc } = nativeClient();
		channelFactory
			.mockImplementationOnce(() => ({
				client: rpc,
				ready: new Promise<void>((resolve) => setTimeout(resolve, 600)),
				close,
			}))
			.mockImplementationOnce(() => ({ client: rpc, ready: new Promise<void>(() => {}), close }));
		let settled = false;
		const expired = expect(
			client.preconnect('sandbox', { timeoutMs: 1_000 }).finally(() => {
				settled = true;
			}),
		).rejects.toThrow('Direct data-plane access is unavailable');
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expired;
		expect(acquire).toHaveBeenCalledTimes(2);
		expect(acquire.mock.calls[1][1]).toBe(400);
		expect(release).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('cancels an in-flight channel wait and releases its lease without preparing more permissions', async () => {
		const { client, acquire, release, channelFactory, close, rpc } = nativeClient();
		channelFactory.mockReturnValue({ client: rpc, ready: new Promise<void>(() => {}), close });
		const controller = new AbortController();
		const reason = new Error('shutdown');
		const pending = expect(
			client.preconnect('sandbox', { signal: controller.signal }),
		).rejects.toBe(reason);
		await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
		controller.abort(reason);
		await pending;
		expect(release).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(acquire).toHaveBeenCalledTimes(1);
	});

	it('uses the background budget in auto mode without extending the foreground budget', async () => {
		vi.useFakeTimers();
		const { client, issue, dataPlane } = nativeClient('auto');
		const credential = issue.getMockImplementation()!;
		issue.mockImplementation(async (id, permission) => {
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			return credential(id, permission);
		});
		// Previously the foreground one-second auto budget made background preparation fall back.
		const prepared = expect(client.preconnect('sandbox', { timeoutMs: 7_000 })).resolves.toBe(true);
		await vi.advanceTimersByTimeAsync(6_000);
		await prepared;
		expect(dataPlane.stateFor('sandbox').retryAtMs).toBe(0);
		const foreground = expect(
			dataPlane.acquire({ sandboxId: 'cold', permission: 1, dataPlaneMode: 'auto' }),
		).resolves.toBeUndefined();
		await vi.advanceTimersByTimeAsync(1_000);
		await foreground;
		await vi.advanceTimersByTimeAsync(200);
	});

	it('returns false for auto fallback or Gateway mode without changing the cooldown', async () => {
		const auto = nativeClient('auto');
		auto.channelFactory.mockImplementation(() => {
			throw new Error('endpoint unavailable');
		});
		expect(await auto.client.preconnect('sandbox')).toBe(false);
		expect(auto.dataPlane.stateFor('sandbox').retryAtMs).toBe(0);
		const gateway = nativeClient('gateway');
		expect(await gateway.client.preconnect('sandbox')).toBe(false);
		expect(gateway.issue).not.toHaveBeenCalled();
	});
});
