import { describe, it, expect, vi } from 'vitest';
import { NOT_A_DIRECTORY_MARKER } from '@marimo-hub/compute-commons';
import type { SandboxId } from '@marimo-hub/core/ids';
import { listFilesFailure } from '@marimo-hub/core/ports/sandbox';
import { expectFileResult } from '@marimo-hub/core/testing/result-assertions';
import {
	computeContract,
	CONTRACT_NON_DIRECTORY_PATH,
	scriptContractLaunch,
} from '@marimo-hub/core/testing/compute-contract';

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

		it('surfaces success:false from the SDK exec result', async () => {
			fakeSandbox.exec.mockResolvedValueOnce({
				success: false,
				stdout: '',
				stderr: 'boom',
				error: { code: 'COMMAND_FAILED' },
			});
			const res = await makeProvider().create(SANDBOX_ID).exec('bad');
			expect(res).toEqual({
				success: false,
				stdout: '',
				stderr: 'boom',
				error: { code: 'COMMAND_FAILED' },
			});
		});

		it('passes an extended command timeout to the SDK', async () => {
			fakeSandbox.exec.mockClear();
			fakeSandbox.exec.mockResolvedValueOnce({ success: true, stdout: '', stderr: '' });

			await makeProvider().create(SANDBOX_ID).exec('uv sync', { timeout: 300_000 });

			expect(fakeSandbox.exec).toHaveBeenCalledWith('uv sync', { timeout: 300_000 });
		});
	});

	describe('instance.writeFiles() bytes', () => {
		it('base64-armors non-string bytes via writeFile({encoding:base64}), never an inline argv (ARG_MAX)', async () => {
			fakeSandbox.writeFile.mockClear();
			fakeSandbox.writeFile.mockResolvedValueOnce(undefined);
			const big = new Uint8Array(512 * 1024);
			for (let i = 0; i < big.length; i++) big[i] = i % 256;

			await makeProvider()
				.create(SANDBOX_ID)
				.writeFiles([{ path: '/f.bin', content: big }]);

			const [path, armored, opts] = fakeSandbox.writeFile.mock.calls.at(-1)!;
			expect(path).toBe('/f.bin');
			expect(opts).toEqual({ encoding: 'base64' });
			// The payload is base64 TEXT that decodes back to the original bytes.
			expect(typeof armored).toBe('string');
			expect(atob(armored as string).length).toBe(big.length);
		});

		it('destroy is idempotent (each call delegates to the SDK)', async () => {
			fakeSandbox.destroy.mockResolvedValue(undefined);
			const instance = makeProvider().create(SANDBOX_ID);
			await instance.destroy();
			await expect(instance.destroy()).resolves.toBeUndefined();
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

		it('stops polling and returns at the cap when the tunnel URL never resolves', async () => {
			fakeSandbox.tunnels.get.mockResolvedValueOnce({ url: 'https://never.trycloudflare.com' });
			const instance = new CloudflareSandboxProvider(fakeNamespace, { useTunnel: true }).create(
				SANDBOX_ID,
			);
			const fetchSpy = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
			vi.stubGlobal('fetch', fetchSpy);
			// Jump Date.now past the readiness cap after the first probe so the poll
			// terminates without a real 10s wait.
			const now = vi.spyOn(Date, 'now');
			now.mockReturnValueOnce(0).mockReturnValue(1_000_000);
			try {
				const result = await instance.exposePort(8080, { hostname: 'ignored' });
				expect(fetchSpy).toHaveBeenCalledTimes(1);
				expect(result).toEqual({ url: 'https://never.trycloudflare.com' });
			} finally {
				now.mockRestore();
				vi.unstubAllGlobals();
			}
		});

		it('keeps polling while the probe returns 5xx, then returns on success', async () => {
			fakeSandbox.tunnels.get.mockResolvedValueOnce({ url: 'https://slow.trycloudflare.com' });
			const instance = new CloudflareSandboxProvider(fakeNamespace, { useTunnel: true }).create(
				SANDBOX_ID,
			);
			const fetchSpy = vi
				.fn()
				.mockResolvedValueOnce({ status: 503 })
				.mockResolvedValueOnce({ status: 200 });
			vi.stubGlobal('fetch', fetchSpy);
			try {
				const result = await instance.exposePort(8080, { hostname: 'ignored' });
				expect(fetchSpy).toHaveBeenCalledTimes(2);
				expect(result).toEqual({ url: 'https://slow.trycloudflare.com' });
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
		it('advertises supportsBucketMount: true so mount failures are not hidden', () => {
			expect(makeProvider().create(SANDBOX_ID).supportsBucketMount).toBe(true);
		});

		it('keeps endpoint mount credentials behind the credential proxy', async () => {
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
				credentialProxy: true,
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
		it('translates a find failure into the typed failure envelope', async () => {
			fakeSandbox.listFiles.mockClear();
			fakeSandbox.exec.mockResolvedValueOnce({
				success: false,
				stdout: '',
				stderr: 'find failed',
				error: { code: 'COMMAND_FAILED' },
			});
			const res = await makeProvider().create(SANDBOX_ID).listFiles('/w');
			expect(res).toEqual(listFilesFailure());
			expect(fakeSandbox.listFiles).not.toHaveBeenCalled();
		});

		it('lists and parses newline-containing filenames in one exec call', async () => {
			fakeSandbox.listFiles.mockClear();
			fakeSandbox.exec.mockResolvedValueOnce({
				success: true,
				stdout: 'f\t12\t/w/a\nnotebook.py\0',
				stderr: '',
			});
			const res = await makeProvider()
				.create(SANDBOX_ID)
				.listFiles('/w', { recursive: true, includeHidden: true });
			expect(fakeSandbox.exec).toHaveBeenLastCalledWith(expect.stringContaining("find '/w'"));
			expect(fakeSandbox.exec.mock.calls.at(-1)?.[0]).not.toContain('-maxdepth');
			expect(fakeSandbox.listFiles).not.toHaveBeenCalled();
			expect(res).toEqual({
				success: true,
				files: [
					{
						name: 'a\nnotebook.py',
						absolutePath: '/w/a\nnotebook.py',
						relativePath: 'a\nnotebook.py',
						type: 'file',
						size: 12,
					},
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
		it('writeFile / setEnvVars / unmountBucket / destroy forward; gitCheckout clones via exec', async () => {
			for (const fn of [
				fakeSandbox.writeFile,
				fakeSandbox.setEnvVars,
				fakeSandbox.unmountBucket,
				fakeSandbox.destroy,
			]) {
				fn.mockResolvedValueOnce(undefined);
			}
			const instance = makeProvider().create(SANDBOX_ID);

			await instance.writeFiles([{ path: '/f', content: 'data' }]);
			expect(fakeSandbox.writeFile).toHaveBeenCalledWith('/f', 'data');
			fakeSandbox.exec.mockResolvedValueOnce({ success: true, stdout: '', stderr: '' });
			await instance.gitCheckout('https://x/y', { branch: 'main' });
			expect(fakeSandbox.exec).toHaveBeenCalledWith("git clone --branch 'main' 'https://x/y' '.'");
			await instance.setEnvVars({ A: '1' });
			expect(fakeSandbox.setEnvVars).toHaveBeenCalledWith({ A: '1' });
			await instance.unmountBucket('/m');
			expect(fakeSandbox.unmountBucket).toHaveBeenCalledWith('/m');
			await instance.destroy();
			expect(fakeSandbox.destroy).toHaveBeenCalled();
		});

		it('setEnvVars with onlyIfUnset skips the SDK and prefixes commands instead', async () => {
			fakeSandbox.setEnvVars.mockClear();
			fakeSandbox.exec.mockResolvedValueOnce({ success: true, stdout: '', stderr: '' });
			const instance = makeProvider().create(SANDBOX_ID);

			await instance.setEnvVars({ CACHE: '/tmp/c' }, { onlyIfUnset: true });
			expect(fakeSandbox.setEnvVars).not.toHaveBeenCalled();

			await instance.exec('run');
			expect(fakeSandbox.exec).toHaveBeenCalledWith(
				'[ -n "${CACHE+x}" ] || export CACHE=\'/tmp/c\'; run',
			);

			fakeSandbox.startProcess.mockResolvedValueOnce({
				id: 'p1',
				command: 'serve',
				kill: async () => {},
				waitForPort: async () => {},
				getLogs: async () => ({ stdout: '', stderr: '' }),
			});
			await instance.startProcess('serve');
			expect(fakeSandbox.startProcess).toHaveBeenCalledWith(
				'[ -n "${CACHE+x}" ] || export CACHE=\'/tmp/c\'; serve',
				expect.anything(),
			);

			fakeSandbox.exec.mockResolvedValueOnce({ success: true, stdout: '', stderr: '' });
			await instance.gitCheckout('https://x/y');
			expect(fakeSandbox.exec).toHaveBeenCalledWith(
				"[ -n \"${CACHE+x}\" ] || export CACHE='/tmp/c'; git clone 'https://x/y' '.'",
			);
		});
	});

	describe('provider surface', () => {
		it('does not implement listActive (reconciler skips provider-truth for this backend)', () => {
			expect((makeProvider() as { listActive?: unknown }).listActive).toBeUndefined();
		});
	});
});

function primeContractFakes() {
	fakeSandbox.exec.mockImplementation(async (cmd: string) =>
		cmd.includes(CONTRACT_NON_DIRECTORY_PATH)
			? {
					success: false,
					stdout: '',
					stderr: NOT_A_DIRECTORY_MARKER,
					error: { code: 'COMMAND_FAILED' },
				}
			: cmd.includes('mh-contract-fail')
				? {
						success: false,
						stdout: '',
						stderr: 'scripted failure',
						error: { code: 'COMMAND_FAILED' },
					}
				: { success: true, stdout: '', stderr: '' },
	);
	fakeSandbox.execStream.mockImplementation(async () => new ReadableStream());
	// The adapter's launch rides the SDK process API (launchWithProcess): script
	// the supervisor transcript into getLogs and answer readiness per the script.
	fakeSandbox.startProcess.mockImplementation(async (cmd: string) => {
		const launch = scriptContractLaunch(cmd);
		return {
			id: 'contract-proc',
			command: cmd,
			kill: async () => {},
			waitForPort: async (port: number) => {
				if (!launch?.portOpen) throw new Error(`timed out waiting for port ${port}`);
			},
			getLogs: async () => ({ stdout: '', stderr: launch?.transcript ?? '' }),
		};
	});
	fakeSandbox.readFile.mockImplementation(async () => ({ success: false }));
	fakeSandbox.writeFile.mockResolvedValue(undefined);
	fakeSandbox.listFiles.mockImplementation(async () => ({ success: true, files: [] }));
	fakeSandbox.setEnvVars.mockResolvedValue(undefined);
	fakeSandbox.mountBucket.mockResolvedValue(undefined);
	fakeSandbox.unmountBucket.mockResolvedValue(undefined);
	fakeSandbox.destroy.mockResolvedValue(undefined);
	fakeSandbox.exposePort.mockImplementation(async () => ({ url: 'https://tunnel.example.com' }));
	proxyToSandbox.mockResolvedValue(null);
}

computeContract(
	'CloudflareSandboxProvider',
	() => {
		primeContractFakes();
		return makeProvider();
	},
	{
		semantics: {
			failingCommand: 'mh-contract-fail',
			launch: {},
			// The SDK failure shape does not distinguish an absent file.
			absentFile: { path: '/contract-absent.txt', code: 'READ_FAILED' },
		},
	},
);

describe('CloudflareSandboxInstance.readFile', () => {
	it('returns a failed ReadFileResult instead of rejecting when the SDK throws', async () => {
		const notFound = new Error('File not found: /missing');
		notFound.name = 'FileNotFoundError';
		fakeSandbox.readFile.mockRejectedValueOnce(notFound);
		const instance = new CloudflareSandboxProvider(fakeNamespace).create(SANDBOX_ID);
		const result = await instance.readFile('/missing');
		expectFileResult(result, { success: false, error: { code: 'NOT_FOUND' } });
	});
});

describe('bounded file transport', () => {
	it('reads SSE output without using the buffered file API', async () => {
		const encode = new TextEncoder();
		fakeSandbox.execStream.mockResolvedValueOnce(
			new ReadableStream({
				start(c) {
					c.enqueue(
						encode.encode(
							'data: {"type":"stdout","data":"aGk="}\n\ndata: {"type":"complete","exitCode":0}\n\n',
						),
					);
					c.close();
				},
			}),
		);
		expect(
			await makeProvider().create(SANDBOX_ID).readFileBounded!('/workspace/file', {
				maxBytes: 2,
				timeoutMs: 100,
			}),
		).toEqual({ success: true, content: 'aGk=', encoding: 'base64' });
	});

	it.each([
		'data: invalid-json\n\n',
		'data: {"type":"stdout","data":"aGk="}\n\n',
		'data: {"type":"stdout","data":"aGk="}\n\ndata: {"type":"complete","exitCode":1}\n\n',
		'data: {"type":"stdout","data":"aGk="}\n\ndata: {"type":"stderr","data":"x"}\n\ndata: {"type":"complete","exitCode":0}\n\n',
	])('refuses malformed, incomplete, failed, or over-budget SSE output: %s', async (wire) => {
		fakeSandbox.execStream.mockResolvedValueOnce(
			new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode(wire));
					c.close();
				},
			}),
		);
		expect(
			(
				await makeProvider().create(SANDBOX_ID).readFileBounded!('/workspace/file', {
					maxBytes: 2,
					timeoutMs: 100,
				})
			).success,
		).toBe(false);
	});

	it('accepts thousands of single-byte output events within the decoded budget', async () => {
		const data = `${'data: {"type":"stdout","data":"x"}\n\n'.repeat(3_000)}data: {"type":"complete","exitCode":0}\n\n`;
		fakeSandbox.execStream.mockResolvedValueOnce(
			new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode(data));
					c.close();
				},
			}),
		);
		const result = await makeProvider()
			.create(SANDBOX_ID)
			.exec('chatty', { maxOutputBytes: 3_000 });
		expect(result).toMatchObject({ success: true, stdout: 'x'.repeat(3_000), stderr: '' });
	});

	it.each([100.5, 2 ** 31 - 1])('accepts bounded read timeout %s', async (timeoutMs) => {
		fakeSandbox.execStream.mockResolvedValueOnce(
			new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode('data: {"type":"complete","exitCode":0}\n\n'));
					c.close();
				},
			}),
		);
		expect(
			await makeProvider().create(SANDBOX_ID).readFileBounded!('/workspace/empty', {
				maxBytes: 0,
				timeoutMs,
			}),
		).toEqual({ success: true, content: '', encoding: 'base64' });
		expect(fakeSandbox.execStream).toHaveBeenLastCalledWith(expect.any(String), {
			timeout: Math.ceil(timeoutMs),
			signal: expect.any(AbortSignal),
		});
	});

	it('rejects out-of-range read timeout before starting the command', async () => {
		fakeSandbox.execStream.mockClear();
		expect(
			await makeProvider().create(SANDBOX_ID).readFileBounded!('/workspace/empty', {
				maxBytes: 0,
				timeoutMs: 2 ** 31,
			}),
		).toMatchObject({ success: false, error: { code: 'READ_FAILED' } });
		expect(fakeSandbox.execStream).not.toHaveBeenCalled();
	});

	it('bounds an unterminated frame independently of the total framing allowance', async () => {
		const cancel = vi.fn();
		fakeSandbox.execStream.mockResolvedValueOnce(
			new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode('data: '));
					c.enqueue(new Uint8Array(64 * 1024 + 32).fill(120));
				},
				cancel,
			}),
		);
		await expect(
			makeProvider().create(SANDBOX_ID).exec('unterminated', { maxOutputBytes: 4 }),
		).rejects.toThrow('SSE frame limit exceeded');
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('cancels an oversized wire stream before its deadline', async () => {
		const maxOutputBytes = 4;
		const cancel = vi.fn();
		fakeSandbox.execStream.mockResolvedValueOnce(
			new ReadableStream({
				start(c) {
					c.enqueue(new Uint8Array(1024 * 1024));
				},
				cancel,
			}),
		);
		await expect(
			makeProvider().create(SANDBOX_ID).exec('cmd', {
				maxOutputBytes,
				timeout: 1000,
			}),
		).rejects.toThrow('SSE wire limit exceeded');
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('cancels a stalled wire stream', async () => {
		const cancel = vi.fn();
		fakeSandbox.execStream.mockResolvedValueOnce(new ReadableStream({ cancel }));
		expect(
			(
				await makeProvider().create(SANDBOX_ID).readFileBounded!('/workspace/file', {
					maxBytes: 2,
					timeoutMs: 10,
				})
			).success,
		).toBe(false);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it.each(['stdout', 'stderr'])(
		'cancels immediately when decoded %s exceeds the combined budget',
		async (type) => {
			const cancel = vi.fn();
			fakeSandbox.execStream.mockResolvedValueOnce(
				new ReadableStream({
					start(c) {
						c.enqueue(
							new TextEncoder().encode(
								'data: {"type":"stdout","data":"a"}\n\n' +
									`data: ${JSON.stringify({ type, data: 'é' })}\n\n`,
							),
						);
					},
					cancel,
				}),
			);
			await expect(
				makeProvider().create(SANDBOX_ID).exec('cmd', {
					maxOutputBytes: 2,
					timeout: 1000,
				}),
			).rejects.toThrow('Sandbox output limit exceeded');
			expect(cancel).toHaveBeenCalledOnce();
		},
	);

	it.each(['stdout', 'stderr'])(
		'rejects malformed %s payloads instead of persisting empty data',
		async (type) => {
			for (const data of [undefined, null, 42, {}, []]) {
				fakeSandbox.execStream.mockResolvedValueOnce(
					new ReadableStream({
						start(c) {
							c.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({ type, data })}\n\ndata: {"type":"complete","exitCode":0}\n\n`,
								),
							);
							c.close();
						},
					}),
				);
				expect(
					(
						await makeProvider().create(SANDBOX_ID).readFileBounded!('/workspace/file', {
							maxBytes: 2,
							timeoutMs: 100,
						})
					).success,
				).toBe(false);
			}
		},
	);

	it.each([0, Infinity])(
		'preserves split UTF-8 SSE frames at the exact output budget with timeout %s',
		async (timeout) => {
			const wire = new TextEncoder().encode(
				'data: {"type":"stdout","data":"é"}\r\n\r\ndata: {"type":"complete","exitCode":0}\r\n\r\n',
			);
			fakeSandbox.execStream.mockResolvedValueOnce(
				new ReadableStream({
					async start(c) {
						await new Promise((resolve) => setTimeout(resolve, 10));
						for (const byte of wire) c.enqueue(new Uint8Array([byte]));
						c.close();
					},
				}),
			);
			expect(
				await makeProvider().create(SANDBOX_ID).exec('cmd', {
					maxOutputBytes: 2,
					timeout,
				}),
			).toMatchObject({ success: true, stdout: 'é', stderr: '' });
		},
	);

	it.each([Number.NaN, Infinity, -1])(
		'rejects invalid output budget %s before starting a command',
		async (maxOutputBytes) => {
			fakeSandbox.execStream.mockClear();
			await expect(
				makeProvider().create(SANDBOX_ID).exec('cmd', { maxOutputBytes }),
			).rejects.toThrow();
			expect(fakeSandbox.execStream).not.toHaveBeenCalled();
		},
	);
});
