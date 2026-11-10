import {
	CWSandboxAuthenticationError,
	CWSandboxTimeoutError,
	CWSandboxUnavailableError,
} from '@coreweave/cwsandbox';
import { createSandboxClient } from '@coreweave/cwsandbox/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

type Mode = 'auto' | 'direct' | 'gateway';
interface Credential {
	cacheKey: string;
	expiresAtMs: number;
	grantedPermissions: Set<number>;
}
interface Lease {
	release(options?: { discard?: boolean }): Promise<void>;
}
interface Channel {
	ready: Promise<void>;
	client: object;
	close(): void;
}
interface Pool {
	constructor: new (maxIdle: number, factory: (bundle: Credential) => Channel) => Pool;
	entries: Map<string, { activeLeases: number }>;
}
interface NativeDataPlane {
	pool: Pool;
	discardSandbox(id: string): void;
	stateFor(id: string): {
		retryAtMs: number;
		credentials: Map<number, Credential>;
	};
	issueCredential(id: string, permission: number): Promise<Credential>;
	acquire(options: {
		sandboxId: string;
		permission: number;
		dataPlaneMode: Mode;
		timeoutMs: number;
	}): Promise<Lease | undefined>;
}

function nativeClient(mode: Mode = 'direct') {
	const client = createSandboxClient({ apiKey: 'test-key', dataPlaneMode: mode });
	const response = { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
	const rpc = {
		exec: vi.fn(() => ({ response: Promise.resolve(response) })),
		writeFile: vi.fn(() => ({ response: Promise.resolve({}) })),
		readFile: vi.fn(() => ({
			response: Promise.resolve({ content: new TextEncoder().encode('content') }),
		})),
	};
	let sequence = 0;
	const credential = (id: string, permission: number): Credential => ({
		cacheKey: `${id}:${permission}:${++sequence}`,
		expiresAtMs: Date.now() + 120_000,
		grantedPermissions: new Set([permission]),
	});
	const issue = vi.fn(async (id: string, permission: number) => credential(id, permission));
	const connect = vi.fn(async (_bundle: Credential) => {});
	const close = vi.fn((_key: string) => {});
	// Preserve the SDK cache, admission, leases and eviction; replace only external I/O.
	const native = client as unknown as {
		transport: {
			get: (request: { sandboxId: string }) => Promise<unknown>;
			directDataPlane: NativeDataPlane;
		};
	};
	const dataPlane = native.transport.directDataPlane;
	dataPlane.issueCredential = issue;
	dataPlane.pool = new dataPlane.pool.constructor(64, (bundle) => ({
		ready: connect(bundle),
		client: rpc,
		close: () => close(bundle.cacheKey),
	}));
	native.transport.get = async ({ sandboxId }) => ({
		sandboxId,
		metadata: { sandboxId, status: 'running' },
	});
	const foreground = async (id: string, permission = 1) => {
		const lease = await dataPlane.acquire({
			sandboxId: id,
			permission,
			dataPlaneMode: mode,
			timeoutMs: 5_000,
		});
		expect(lease).toBeDefined();
		return lease!;
	};
	const idle = () =>
		[...dataPlane.pool.entries.values()].every((entry) => entry.activeLeases === 0);
	return { client, issue, connect, close, rpc, dataPlane, credential, foreground, idle };
}

describe('installed SDK preconnect extension', () => {
	it('prepares all permissions without runner operations and reuses them for exec/read/write', async () => {
		vi.useFakeTimers();
		const { client, issue, connect, rpc, idle } = nativeClient();
		expect(await client.preconnect('sandbox')).toBe(true);
		expect(issue.mock.calls.map((args) => args[1])).toEqual([1, 2, 3, 4, 5]);
		expect(connect).toHaveBeenCalledTimes(5);
		expect(idle()).toBe(true);
		for (const call of Object.values(rpc)) expect(call).not.toHaveBeenCalled();
		const sandbox = await client.fromId('sandbox');
		await sandbox.commands.run(['true']);
		await sandbox.files.write([{ path: '/tmp/file', content: 'content' }]);
		expect(await sandbox.files.readText('/tmp/file')).toBe('content');
		expect(await client.preconnect('sandbox')).toBe(true);
		expect(issue).toHaveBeenCalledTimes(5);
		expect(connect).toHaveBeenCalledTimes(5);
		expect(idle()).toBe(true);
	});

	it('uses the full background budget in Auto mode while foreground attempts retain their one-second budget', async () => {
		vi.useFakeTimers();
		const { client, issue, credential, connect, dataPlane } = nativeClient('auto');
		issue.mockImplementation(async (id, permission) => {
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			return credential(id, permission);
		});
		const settled = vi.fn();
		const preparation = client.preconnect('warm', { timeoutMs: 7_000 });
		void preparation.then(settled, settled);
		const prepared = expect(preparation).resolves.toBe(true);
		await vi.advanceTimersByTimeAsync(5_999);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await prepared;
		expect(issue).toHaveBeenCalledTimes(5);
		expect(connect).toHaveBeenCalledTimes(5);

		settled.mockClear();
		const foreground = dataPlane.acquire({
			sandboxId: 'cold',
			permission: 1,
			dataPlaneMode: 'auto',
			timeoutMs: 7_000,
		});
		void foreground.then(settled, settled);
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await expect(foreground).resolves.toBeUndefined();
		expect(connect).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(200);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps the old credential and channel when an early refresh cannot connect', async () => {
		vi.useFakeTimers();
		const { client, dataPlane, connect, close, foreground } = nativeClient();
		await (await foreground('sandbox')).release();
		const old = dataPlane.stateFor('sandbox').credentials.get(1)!;
		await vi.advanceTimersByTimeAsync(75_000);
		connect.mockRejectedValueOnce(new Error('TLS handshake unavailable'));
		await expect(client.preconnect('sandbox')).rejects.toBeInstanceOf(CWSandboxUnavailableError);
		expect(dataPlane.stateFor('sandbox').credentials.get(1)).toBe(old);
		expect(close).not.toHaveBeenCalledWith(old.cacheKey);
		const sandbox = await client.fromId('sandbox');
		await expect(sandbox.commands.run(['true'])).resolves.toMatchObject({ exitCode: 0 });
		expect(connect).toHaveBeenCalledTimes(2);
	});

	it('publishes a successful refresh but retains an old channel until its active lease ends', async () => {
		vi.useFakeTimers();
		const { client, dataPlane, issue, close, foreground, idle } = nativeClient();
		const active = await foreground('sandbox');
		const old = dataPlane.stateFor('sandbox').credentials.get(1)!;
		await vi.advanceTimersByTimeAsync(75_000);
		expect(await client.preconnect('sandbox')).toBe(true);
		const replacement = dataPlane.stateFor('sandbox').credentials.get(1)!;
		expect(replacement.cacheKey).not.toBe(old.cacheKey);
		expect(issue).toHaveBeenCalledTimes(6);
		expect(close).not.toHaveBeenCalledWith(old.cacheKey);
		await active.release();
		expect(close).toHaveBeenCalledWith(old.cacheKey);
		await (await foreground('sandbox')).release();
		expect(issue).toHaveBeenCalledTimes(6);
		expect(idle()).toBe(true);
	});

	it('never evicts foreground channels to admit background preparation', async () => {
		const { client, foreground, connect, close, dataPlane } = nativeClient();
		for (let i = 0; i < 40; i++) await (await foreground(`foreground-${i}`)).release();
		for (let i = 0; i < 8; i++) await client.preconnect(`warm-${i}`);
		expect(dataPlane.pool.entries.size).toBeLessThanOrEqual(64);
		expect(close.mock.calls.some(([key]) => key.startsWith('foreground-'))).toBe(false);
		const connections = connect.mock.calls.length;
		for (let i = 0; i < 40; i++) await (await foreground(`foreground-${i}`)).release();
		expect(connect).toHaveBeenCalledTimes(connections);
		for (let i = 40; i < 64; i++) await (await foreground(`foreground-${i}`)).release();
		const fullCacheConnections = connect.mock.calls.length;
		expect(await client.preconnect('no-spare-capacity')).toBe(false);
		expect(connect).toHaveBeenCalledTimes(fullCacheConnections);
		expect(close.mock.calls.some(([key]) => key.startsWith('foreground-'))).toBe(false);
	});

	it('evicts speculative channels first, even after background reuse, and promotes foreground use', async () => {
		const { client, foreground, close, connect, dataPlane } = nativeClient();
		for (let i = 0; i < 24; i++) await (await foreground(`foreground-${i}`)).release();
		for (let i = 0; i < 8; i++) expect(await client.preconnect(`warm-${i}`)).toBe(true);
		await (await foreground('warm-0')).release();
		expect(await client.preconnect('warm-0')).toBe(true);
		const promoted = dataPlane.stateFor('warm-0').credentials.get(1)!;
		for (let i = 24; i < 63; i++) await (await foreground(`foreground-${i}`)).release();
		expect(close).not.toHaveBeenCalledWith(promoted.cacheKey);
		expect(close.mock.calls.every(([key]) => key.startsWith('warm-'))).toBe(true);
		const connections = connect.mock.calls.length;
		await (await foreground('warm-0')).release();
		expect(connect).toHaveBeenCalledTimes(connections);
	});

	it('bounds speculative channels and preserves the previous channel during failed refresh at capacity', async () => {
		vi.useFakeTimers();
		const { client, foreground, connect, close, dataPlane } = nativeClient();
		for (let i = 0; i < 10; i++) expect(await client.preconnect(`warm-${i}`)).toBe(true);
		expect(dataPlane.pool.entries.size).toBe(40);
		const oldestKey = dataPlane.pool.entries.keys().next().value!;
		const sandboxId = oldestKey.split(':')[0];
		const old = dataPlane.stateFor(sandboxId).credentials.get(1)!;
		expect(old.cacheKey).toBe(oldestKey);
		await vi.advanceTimersByTimeAsync(75_000);
		connect.mockRejectedValueOnce(new Error('renewal handshake failed'));
		await expect(client.preconnect(sandboxId)).rejects.toBeInstanceOf(CWSandboxUnavailableError);
		expect(dataPlane.stateFor(sandboxId).credentials.get(1)).toBe(old);
		expect(close).not.toHaveBeenCalledWith(oldestKey);
		const connections = connect.mock.calls.length;
		await (await foreground(sandboxId)).release();
		expect(connect).toHaveBeenCalledTimes(connections);
	});

	it.each<Mode>(['auto', 'direct'])(
		'enforces the shared deadline during a pending connection (%s)',
		async (mode) => {
			vi.useFakeTimers();
			const { client, connect, close, idle } = nativeClient(mode);
			connect.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 600)));
			connect.mockImplementationOnce(() => new Promise(() => {}));
			const settled = vi.fn();
			const preparation = client.preconnect('sandbox', { timeoutMs: 1_000 });
			void preparation.then(settled, settled);
			const expired = expect(preparation).rejects.toBeInstanceOf(CWSandboxTimeoutError);
			await vi.advanceTimersByTimeAsync(999);
			expect(connect).toHaveBeenCalledTimes(2);
			expect(settled).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await expired;
			expect(settled).toHaveBeenCalledTimes(1);
			expect(close).toHaveBeenCalledTimes(1);
			expect(idle()).toBe(true);
		},
	);

	it('aborts a pending connection promptly and cleans up its speculative channel', async () => {
		vi.useFakeTimers();
		const { client, connect, close, dataPlane } = nativeClient();
		connect.mockImplementationOnce(() => new Promise(() => {}));
		const controller = new AbortController();
		const reason = new Error('server draining');
		const preparation = client.preconnect('sandbox', { signal: controller.signal });
		const cancelled = expect(preparation).rejects.toBe(reason);
		await vi.advanceTimersByTimeAsync(0);
		expect(connect).toHaveBeenCalledTimes(1);
		controller.abort(reason);
		await cancelled;
		expect(close).toHaveBeenCalledTimes(1);
		expect(dataPlane.pool.entries.size).toBe(0);
		expect(dataPlane.stateFor('sandbox').credentials.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('cancels a background credential waiter without cancelling a foreground request sharing issuance', async () => {
		vi.useFakeTimers();
		const { client, issue, credential, foreground, idle } = nativeClient();
		const issuance = Promise.withResolvers<Credential>();
		issue.mockReturnValueOnce(issuance.promise);
		const controller = new AbortController();
		const reason = new Error('stop background work');
		const preparation = client.preconnect('sandbox', { signal: controller.signal });
		const cancelled = expect(preparation).rejects.toBe(reason);
		await vi.advanceTimersByTimeAsync(0);
		const request = foreground('sandbox');
		await vi.advanceTimersByTimeAsync(0);
		expect(issue).toHaveBeenCalledTimes(1);
		controller.abort(reason);
		await cancelled;
		issuance.resolve(credential('sandbox', 1));
		await (await request).release();
		expect(issue).toHaveBeenCalledTimes(1);
		expect(idle()).toBe(true);
	});

	it('discards a late preparation instead of overwriting a newer foreground credential', async () => {
		vi.useFakeTimers();
		const { client, foreground, connect, close, dataPlane } = nativeClient();
		await (await foreground('sandbox')).release();
		dataPlane.stateFor('sandbox').credentials.get(1)!.expiresAtMs = Date.now() + 31_000;
		const handshake = Promise.withResolvers<void>();
		connect.mockReturnValueOnce(handshake.promise);
		const preparation = client.preconnect('sandbox');
		await vi.advanceTimersByTimeAsync(1_500);
		await (await foreground('sandbox')).release();
		const current = dataPlane.stateFor('sandbox').credentials.get(1)!;
		handshake.resolve();
		expect(await preparation).toBe(false);
		expect(dataPlane.stateFor('sandbox').credentials.get(1)).toBe(current);
		expect(close).not.toHaveBeenCalledWith(current.cacheKey);
		expect(close).toHaveBeenCalledWith(connect.mock.calls[1][0].cacheKey);
	});

	it('does not discard a shared channel when its background waiter is cancelled', async () => {
		vi.useFakeTimers();
		const { client, issue, credential, connect, close, foreground } = nativeClient();
		const issuance = Promise.withResolvers<Credential>();
		const handshake = Promise.withResolvers<void>();
		issue.mockReturnValueOnce(issuance.promise);
		connect.mockReturnValueOnce(handshake.promise);
		const controller = new AbortController();
		const preparation = client.preconnect('sandbox', { signal: controller.signal });
		const cancelled = expect(preparation).rejects.toThrow();
		const request = foreground('sandbox');
		issuance.resolve(credential('sandbox', 1));
		await vi.advanceTimersByTimeAsync(0);
		expect(connect).toHaveBeenCalledTimes(1);
		controller.abort();
		await cancelled;
		handshake.resolve();
		await (await request).release();
		expect(close).not.toHaveBeenCalled();
		await (await foreground('sandbox')).release();
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it('does not restore credentials after a sandbox is discarded during preparation', async () => {
		vi.useFakeTimers();
		const { client, connect, close, dataPlane } = nativeClient();
		const handshake = Promise.withResolvers<void>();
		connect.mockReturnValueOnce(handshake.promise);
		const preparation = client.preconnect('sandbox');
		await vi.advanceTimersByTimeAsync(0);
		dataPlane.discardSandbox('sandbox');
		handshake.resolve();
		expect(await preparation).toBe(false);
		expect(dataPlane.stateFor('sandbox').credentials.size).toBe(0);
		expect(dataPlane.pool.entries.size).toBe(0);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('preserves foreground cooldowns on successful and failed preparation', async () => {
		vi.useFakeTimers();
		const direct = nativeClient();
		const state = direct.dataPlane.stateFor('sandbox');
		const cooldown = Date.now() + 30_000;
		state.retryAtMs = cooldown;
		expect(await direct.client.preconnect('sandbox')).toBe(true);
		expect(state.retryAtMs).toBe(cooldown);
		direct.connect.mockRejectedValueOnce(new Error('endpoint unavailable'));
		const failedState = direct.dataPlane.stateFor('failed');
		failedState.retryAtMs = cooldown;
		await expect(direct.client.preconnect('failed')).rejects.toBeInstanceOf(
			CWSandboxUnavailableError,
		);
		expect(failedState.retryAtMs).toBe(cooldown);
		const auto = nativeClient('auto');
		auto.dataPlane.stateFor('sandbox').retryAtMs = cooldown;
		expect(await auto.client.preconnect('sandbox')).toBe(false);
		expect(auto.issue).not.toHaveBeenCalled();
	});

	it.each<Mode>(['auto', 'direct'])(
		'retains mode-specific fallback and authentication errors (%s)',
		async (mode) => {
			const { client, connect, issue, dataPlane } = nativeClient(mode);
			connect.mockRejectedValueOnce(new Error('endpoint unavailable'));
			if (mode === 'auto') await expect(client.preconnect('unreachable')).resolves.toBe(false);
			else
				await expect(client.preconnect('unreachable')).rejects.toBeInstanceOf(
					CWSandboxUnavailableError,
				);
			expect(dataPlane.stateFor('unreachable').retryAtMs).toBe(0);
			const denied = new CWSandboxAuthenticationError('credentials rejected');
			issue.mockRejectedValueOnce(denied);
			await expect(client.preconnect('unauthorized')).rejects.toBe(denied);
		},
	);

	it('rejects missing permission grants in Direct mode without opening a channel', async () => {
		const { client, issue, credential, connect, rpc } = nativeClient();
		issue.mockResolvedValueOnce({ ...credential('sandbox', 1), grantedPermissions: new Set() });
		await expect(client.preconnect('sandbox')).rejects.toBeInstanceOf(CWSandboxUnavailableError);
		expect(connect).not.toHaveBeenCalled();
		for (const call of Object.values(rpc)) expect(call).not.toHaveBeenCalled();
	});

	it('does no work for pre-aborted requests or Gateway mode', async () => {
		const { client, issue, connect } = nativeClient();
		const controller = new AbortController();
		controller.abort();
		await expect(client.preconnect('sandbox', { signal: controller.signal })).rejects.toThrow();
		expect(issue).not.toHaveBeenCalled();
		expect(connect).not.toHaveBeenCalled();
		const gateway = nativeClient('gateway');
		expect(await gateway.client.preconnect('sandbox')).toBe(false);
		expect(gateway.issue).not.toHaveBeenCalled();
		expect(gateway.connect).not.toHaveBeenCalled();
	});
});
