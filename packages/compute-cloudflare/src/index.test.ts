import { describe, it, expect, vi } from 'vitest';
import type { SandboxId } from '@marimo-hub/core';

/**
 * Tests for the Cloudflare Containers compute adapter.
 *
 * Mocks `@cloudflare/sandbox` entirely (the same pattern used by
 * `packages/auth-cloudflare-access/src/index.test.ts` for `jose`) so the adapter
 * wiring is exercised hermetically with no Workers runtime.
 */

const fakeSandbox = {
	exec: vi.fn(),
	execStream: vi.fn(),
	exposePort: vi.fn(),
	destroy: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	listFiles: vi.fn(),
	gitCheckout: vi.fn(),
	setEnvVars: vi.fn(),
	mountBucket: vi.fn(),
	unmountBucket: vi.fn(),
	startProcess: vi.fn(),
	tunnels: { get: vi.fn() },
};

const getSandbox = vi.fn(() => fakeSandbox);
const proxyToSandbox = vi.fn();

vi.mock('@cloudflare/sandbox', () => ({
	getSandbox: (...a: unknown[]) => (getSandbox as (...x: unknown[]) => unknown)(...a),
	proxyToSandbox: (...a: unknown[]) => (proxyToSandbox as (...x: unknown[]) => unknown)(...a),
	// Re-exported classes — the adapter just re-exports them, so stubs are fine.
	Sandbox: class {},
	ContainerProxy: class {},
}));

const { CloudflareSandboxProvider } = await import('./index');

// A dummy namespace — only its identity matters (threaded through to getSandbox /
// proxyToSandbox); never actually invoked.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeNamespace = {} as unknown as DurableObjectNamespace<any>;

const SANDBOX_ID = 'sb-test' as SandboxId;

function makeProvider() {
	return new CloudflareSandboxProvider(fakeNamespace);
}

describe('CloudflareSandboxProvider', () => {
	describe('create()', () => {
		it('calls getSandbox with the namespace, id, and sleepAfter option', () => {
			getSandbox.mockClear();
			makeProvider().create(SANDBOX_ID);
			expect(getSandbox).toHaveBeenCalledWith(fakeNamespace, SANDBOX_ID, {
				sleepAfter: '20m',
				transport: 'http',
			});
		});

		it('returns a SandboxInstance (defined object)', () => {
			getSandbox.mockReturnValueOnce(fakeSandbox);
			const instance = makeProvider().create(SANDBOX_ID);
			expect(instance).toBeDefined();
		});
	});

	describe('instance.exec()', () => {
		it('delegates to sandbox.exec and maps the result', async () => {
			fakeSandbox.exec.mockResolvedValueOnce({ success: true, stdout: 'ok', stderr: '' });
			const instance = makeProvider().create(SANDBOX_ID);
			const result = await instance.exec('echo ok');
			expect(fakeSandbox.exec).toHaveBeenCalledWith('echo ok');
			expect(result).toEqual({ success: true, stdout: 'ok', stderr: '' });
		});
	});

	describe('instance.exposePort()', () => {
		it('delegates to sandbox.exposePort and returns url', async () => {
			fakeSandbox.exposePort.mockResolvedValueOnce({ url: 'https://tunnel.example.com' });
			const instance = makeProvider().create(SANDBOX_ID);
			const result = await instance.exposePort(8080, { hostname: 'hub.example.com', token: 'tok' });
			expect(fakeSandbox.exposePort).toHaveBeenCalledWith(8080, {
				hostname: 'hub.example.com',
				token: 'tok',
			});
			expect(result).toEqual({ url: 'https://tunnel.example.com' });
		});

		it('with useTunnel, exposes via sandbox.tunnels.get and ignores the hostname', async () => {
			fakeSandbox.exposePort.mockClear();
			getSandbox.mockClear();
			fakeSandbox.tunnels.get.mockResolvedValueOnce({
				url: 'https://random-words.trycloudflare.com',
			});
			const instance = new CloudflareSandboxProvider(fakeNamespace, { useTunnel: true }).create(
				SANDBOX_ID,
			);
			expect(getSandbox).toHaveBeenCalledWith(fakeNamespace, SANDBOX_ID, {
				sleepAfter: '20m',
				transport: 'rpc',
			});
			// The adapter probes the tunnel URL for readiness before returning it.
			const fetchSpy = vi.fn().mockResolvedValue({ status: 200 });
			vi.stubGlobal('fetch', fetchSpy);
			try {
				const result = await instance.exposePort(8080, { hostname: 'ignored.example.com' });
				expect(fakeSandbox.tunnels.get).toHaveBeenCalledWith(8080);
				expect(fakeSandbox.exposePort).not.toHaveBeenCalled();
				expect(fetchSpy).toHaveBeenCalledWith(
					'https://random-words.trycloudflare.com',
					expect.objectContaining({ method: 'GET' }),
				);
				expect(result).toEqual({ url: 'https://random-words.trycloudflare.com' });
			} finally {
				vi.unstubAllGlobals();
			}
		});
	});

	describe('proxy()', () => {
		it('calls proxyToSandbox with the request and the namespace binding', async () => {
			const mockResponse = new Response('ok');
			proxyToSandbox.mockResolvedValueOnce(mockResponse);
			const req = new Request('http://example.com/');
			const result = await makeProvider().proxy(req);
			expect(proxyToSandbox).toHaveBeenCalledWith(req, { Sandbox: fakeNamespace });
			expect(result).toBe(mockResponse);
		});
	});

	describe('instance.mountBucket()', () => {
		it('reshapes the options object into positional (name, path, {endpoint,prefix,credentials})', async () => {
			// The single most error-prone line in the adapter: object → positional args.
			fakeSandbox.mountBucket.mockResolvedValueOnce(undefined);
			const credentials = { accessKeyId: 'a', secretAccessKey: 'b' };
			await makeProvider().create(SANDBOX_ID).mountBucket({
				bucketName: 'bkt',
				mountPath: '/mnt',
				endpoint: 'https://e',
				prefix: 'pfx',
				credentials,
			});
			expect(fakeSandbox.mountBucket).toHaveBeenCalledWith('bkt', '/mnt', {
				endpoint: 'https://e',
				prefix: 'pfx',
				credentials,
			});
		});

		it('with no endpoint, mounts by R2 binding name (no endpoint/credentials passed)', async () => {
			fakeSandbox.mountBucket.mockClear();
			fakeSandbox.mountBucket.mockResolvedValueOnce(undefined);
			await makeProvider().create(SANDBOX_ID).mountBucket({
				bucketName: 'NOTEBOOKS_BUCKET',
				mountPath: '/mnt',
				prefix: 'pfx',
			});
			expect(fakeSandbox.mountBucket).toHaveBeenCalledWith('NOTEBOOKS_BUCKET', '/mnt', {
				prefix: 'pfx',
			});
		});
	});

	describe('instance.startProcess()', () => {
		it('maps options and returns a process delegating to the underlying proc', async () => {
			const proc = {
				id: 'pid',
				command: 'uv run marimo',
				kill: vi.fn().mockResolvedValue(undefined),
				waitForPort: vi.fn().mockResolvedValue(undefined),
				getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
			};
			fakeSandbox.startProcess.mockResolvedValueOnce(proc);

			const result = await makeProvider()
				.create(SANDBOX_ID)
				.startProcess('uv run marimo', {
					processId: 'pid',
					cwd: '/w',
					env: { A: '1' },
					timeout: 5,
				});
			expect(fakeSandbox.startProcess).toHaveBeenCalledWith('uv run marimo', {
				processId: 'pid',
				cwd: '/w',
				env: { A: '1' },
				timeout: 5,
			});
			expect(result.id).toBe('pid');
			expect(result.command).toBe('uv run marimo');

			await result.kill('SIGTERM');
			expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
			await result.waitForPort(8080, { mode: 'http' });
			expect(proc.waitForPort).toHaveBeenCalledWith(8080, { mode: 'http' });
			await result.getLogs();
			expect(proc.getLogs).toHaveBeenCalled();
		});

		it('exposes id/command as live getters over the underlying proc', async () => {
			const proc = {
				id: 'a',
				command: 'c',
				kill: vi.fn(),
				waitForPort: vi.fn(),
				getLogs: vi.fn(),
			};
			fakeSandbox.startProcess.mockResolvedValueOnce(proc);
			const result = await makeProvider().create(SANDBOX_ID).startProcess('run');
			expect(result.id).toBe('a');
			proc.id = 'b';
			expect(result.id).toBe('b'); // getter, not a static copy
		});
	});

	describe('instance.listFiles()', () => {
		it('projects each FileInfo field and forwards the options', async () => {
			fakeSandbox.listFiles.mockResolvedValueOnce({
				success: true,
				files: [
					{
						name: 'a.py',
						absolutePath: '/w/a.py',
						relativePath: 'a.py',
						type: 'file',
						size: 12,
						// an extra SDK field that must NOT leak through the projection
						mode: 0o644,
					},
				],
			});
			const res = await makeProvider()
				.create(SANDBOX_ID)
				.listFiles('/w', { recursive: true, includeHidden: true });
			expect(fakeSandbox.listFiles).toHaveBeenCalledWith('/w', {
				recursive: true,
				includeHidden: true,
			});
			expect(res).toEqual({
				success: true,
				files: [
					{ name: 'a.py', absolutePath: '/w/a.py', relativePath: 'a.py', type: 'file', size: 12 },
				],
			});
		});
	});

	describe('instance.readFile() / execStream()', () => {
		it('readFile maps success/content/encoding', async () => {
			fakeSandbox.readFile.mockResolvedValueOnce({
				success: true,
				content: 'x',
				encoding: 'utf-8',
			});
			const res = await makeProvider().create(SANDBOX_ID).readFile('/f');
			expect(fakeSandbox.readFile).toHaveBeenCalledWith('/f');
			expect(res).toEqual({ success: true, content: 'x', encoding: 'utf-8' });
		});

		it('execStream forwards the timeout option and returns the stream', async () => {
			const stream = new ReadableStream();
			fakeSandbox.execStream.mockResolvedValueOnce(stream);
			const res = await makeProvider().create(SANDBOX_ID).execStream('tail -f', { timeout: 1000 });
			expect(fakeSandbox.execStream).toHaveBeenCalledWith('tail -f', { timeout: 1000 });
			expect(res).toBe(stream);
		});
	});

	describe('simple delegations', () => {
		it('writeFile / gitCheckout / setEnvVars / unmountBucket / destroy forward to the sandbox', async () => {
			for (const fn of [
				fakeSandbox.writeFile,
				fakeSandbox.gitCheckout,
				fakeSandbox.setEnvVars,
				fakeSandbox.unmountBucket,
				fakeSandbox.destroy,
			]) {
				fn.mockResolvedValueOnce(undefined);
			}
			const instance = makeProvider().create(SANDBOX_ID);

			await instance.writeFile('/f', 'data');
			expect(fakeSandbox.writeFile).toHaveBeenCalledWith('/f', 'data');
			await instance.gitCheckout('https://x/y', { branch: 'main' });
			expect(fakeSandbox.gitCheckout).toHaveBeenCalledWith('https://x/y', { branch: 'main' });
			await instance.setEnvVars({ A: '1' });
			expect(fakeSandbox.setEnvVars).toHaveBeenCalledWith({ A: '1' });
			await instance.unmountBucket('/m');
			expect(fakeSandbox.unmountBucket).toHaveBeenCalledWith('/m');
			await instance.destroy();
			expect(fakeSandbox.destroy).toHaveBeenCalled();
		});
	});

	describe('provider surface', () => {
		it('does not implement listActive (reconciler skips provider-truth for this backend)', () => {
			expect((makeProvider() as { listActive?: unknown }).listActive).toBeUndefined();
		});
	});
});
