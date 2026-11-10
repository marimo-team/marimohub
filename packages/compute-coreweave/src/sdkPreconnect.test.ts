import { createSandboxClient } from '@coreweave/cwsandbox/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

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
	const release = vi.fn(async () => {});
	const issue = vi.fn(async (id: string, permission: number) => ({
		cacheKey: `${id}:${permission}`,
		expiresAtMs: Date.now() + 120_000,
		grantedPermissions: new Set([permission]),
	}));
	const acquire = vi.fn(async () => ({ client: rpc, release }));
	// Inject only credential issuance/channel I/O; exercise the installed SDK's cache and public API.
	const native = client as unknown as {
		transport: {
			get: (request: unknown) => Promise<unknown>;
			directDataPlane: {
				stateFor: (id: string) => { retryAtMs: number };
				issueCredential: typeof issue;
				pool: { acquire: typeof acquire };
			};
		};
	};
	native.transport.directDataPlane.issueCredential = issue;
	native.transport.directDataPlane.pool = { acquire };
	native.transport.get = async () => ({
		sandboxId: 'sandbox',
		metadata: { sandboxId: 'sandbox', status: 'running' },
	});
	return { client, issue, acquire, release, rpc, dataPlane: native.transport.directDataPlane };
}

describe('installed SDK preconnect extension', () => {
	it('warms each permission without runner operations, then reuses credentials for real exec/read/write calls', async () => {
		vi.useFakeTimers();
		const { client, issue, release, rpc, dataPlane } = nativeClient();
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
		expect(await client.preconnect('sandbox')).toBe(true);
		expect(issue).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(65_000);
		expect(await client.preconnect('sandbox')).toBe(true);
		expect(issue).toHaveBeenCalledTimes(10);
	});

	it('honors a shared deadline and cancellation, and performs no work in Gateway mode', async () => {
		vi.useFakeTimers();
		const { client, acquire, release, rpc } = nativeClient();
		acquire.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 600));
			return { client: rpc, release };
		});
		const expired = expect(client.preconnect('sandbox', { timeoutMs: 1_000 })).rejects.toThrow(
			'deadline',
		);
		await vi.advanceTimersByTimeAsync(1_200);
		await expired;
		expect(acquire).toHaveBeenCalledTimes(2);
		expect(release).toHaveBeenCalledTimes(2);
		const aborted = new AbortController();
		aborted.abort();
		await expect(client.preconnect('sandbox', { signal: aborted.signal })).rejects.toThrow();
		expect(acquire).toHaveBeenCalledTimes(2);
		const gateway = nativeClient('gateway');
		expect(await gateway.client.preconnect('sandbox')).toBe(false);
		expect(gateway.issue).not.toHaveBeenCalled();
	});
});
