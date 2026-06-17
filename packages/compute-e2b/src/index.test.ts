import { describe, expect, it, vi } from 'vitest';
import { Seconds } from '@marimo-hub/core';
import type { SandboxId } from '@marimo-hub/core';
import { expectListFilesResult } from '@marimo-hub/core/testing';
import { computeContract } from '@marimo-hub/core/testing/compute-contract';
import { createE2bClient, E2bCompute } from './index';
import type {
	E2bClient,
	E2bConfig,
	E2bExecResult,
	E2bSdk,
	E2bSandboxHandle,
	E2bSandboxInfo,
} from './index';

/**
 * Hermetic tests for the E2B adapter: an in-memory fake `E2bClient` (no SDK, no
 * network) keyed by the E2B id it assigns, so reconnect/list/kill-by-tag behave
 * realistically — the analogue of the CoreWeave adapter's fake-client suite.
 */

const SANDBOX_ID = 'sb-aaaaaaaaaaaaaaaa' as SandboxId;
const baseConfig: E2bConfig = { apiKey: 'key', template: 'marimo-tpl' };

interface FakeSandbox {
	info: E2bSandboxInfo;
	files: Map<string, string>;
	killed: boolean;
}

class FakeE2b implements E2bClient {
	readonly sandboxes = new Map<string, FakeSandbox>();
	readonly createCalls: {
		template?: string;
		metadata?: Record<string, string>;
		timeoutMs?: number;
		envs?: Record<string, string>;
	}[] = [];
	readonly runCalls: string[] = [];
	readonly runOptions: {
		cmd: string;
		options?: { cwd?: string; envs?: Record<string, string> };
	}[] = [];
	readonly backgroundCalls: {
		cmd: string;
		options?: { cwd?: string; envs?: Record<string, string> };
	}[] = [];
	killedBackgroundCommands = 0;
	private seq = 0;

	constructor(
		private readonly opts: {
			failOn?: (cmd: string) => boolean;
			runResult?: (cmd: string) => E2bExecResult | undefined;
		} = {},
	) {}

	private makeHandle(sb: FakeSandbox): E2bSandboxHandle {
		return {
			sandboxId: sb.info.sandboxId,
			commands: {
				run: async (cmd, options) => {
					this.runCalls.push(cmd);
					this.runOptions.push({ cmd, options });
					// Make the in-sandbox port probe "succeed" so waitForPort resolves fast.
					if (cmd.includes('connect_ex')) return { stdout: '', stderr: '', exitCode: 0 };
					if (this.opts.failOn?.(cmd)) return { stdout: '', stderr: 'fatal', exitCode: 1 };
					const scripted = this.opts.runResult?.(cmd);
					if (scripted) return scripted;
					return { stdout: '', stderr: '', exitCode: 0 };
				},
				runBackground: async (cmd, options) => {
					this.backgroundCalls.push({ cmd, options });
					return {
						kill: async () => {
							this.killedBackgroundCommands += 1;
						},
					};
				},
			},
			files: {
				// The SDK's write is overloaded (single | batch); model both.
				write: async (pathOrFiles: unknown, content?: unknown) => {
					if (typeof pathOrFiles === 'string') {
						sb.files.set(pathOrFiles, content as string);
						return;
					}
					for (const f of pathOrFiles as { path: string; data: string }[]) {
						sb.files.set(f.path, f.data);
					}
				},
				read: async (path) => {
					const v = sb.files.get(path);
					if (v === undefined) throw new Error('not found');
					return v;
				},
			},
			getHost: (port) => `${port}-${sb.info.sandboxId}.e2b.app`,
			kill: async () => void (sb.killed = true),
		};
	}

	async create(options: {
		template?: string;
		metadata?: Record<string, string>;
		timeoutMs?: number;
	}): Promise<E2bSandboxHandle> {
		this.createCalls.push(options);
		const sandboxId = `e2b-${++this.seq}`;
		const sb: FakeSandbox = {
			info: { sandboxId, startedAt: '2026-01-01T00:00:00Z', metadata: options.metadata },
			files: new Map(),
			killed: false,
		};
		this.sandboxes.set(sandboxId, sb);
		return this.makeHandle(sb);
	}

	async connect(sandboxId: string): Promise<E2bSandboxHandle> {
		const sb = this.sandboxes.get(sandboxId);
		if (!sb) throw new Error(`no sandbox ${sandboxId}`);
		return this.makeHandle(sb);
	}

	async list(): Promise<E2bSandboxInfo[]> {
		return [...this.sandboxes.values()].filter((s) => !s.killed).map((s) => s.info);
	}
}

describe('E2bCompute', () => {
	it('create stamps our SandboxId + owner tag in metadata', async () => {
		const fake = new FakeE2b();
		const sb = new E2bCompute(baseConfig, fake).create(SANDBOX_ID);
		await sb.writeFiles([{ path: '/home/appuser/notebooks/notebook.py', content: 'print(1)\n' }]);

		const created = [...fake.sandboxes.values()][0];
		expect(created.info.metadata?.['mh-sandbox-id']).toBe(SANDBOX_ID);
		expect(created.info.metadata?.['mh-owner']).toBe('marimohub');
		expect(created.files.get('/home/appuser/notebooks/notebook.py')).toBe('print(1)\n');
	});

	it('a per-create image override replaces the configured template', async () => {
		const fake = new FakeE2b();
		await new E2bCompute(baseConfig, fake)
			.create(SANDBOX_ID, { image: 'override-tpl' })
			.exec('true');

		expect(fake.createCalls[0]?.template).toBe('override-tpl');
	});

	it('passes maxLifetimeSeconds to E2B as timeoutMs', async () => {
		const fake = new FakeE2b();

		await new E2bCompute({ ...baseConfig, maxLifetimeSeconds: Seconds.of(90) }, fake)
			.create(SANDBOX_ID)
			.exec('true');

		expect(fake.createCalls[0]?.timeoutMs).toBe(90_000);
	});

	it('reuses the existing sandbox (reconnect by metadata tag), not a second create', async () => {
		const fake = new FakeE2b();
		const compute = new E2bCompute(baseConfig, fake);
		await compute.create(SANDBOX_ID).writeFiles([{ path: '/a', content: '1' }]);
		// A fresh instance for the same id must find + reuse the live sandbox.
		await compute.create(SANDBOX_ID).writeFiles([{ path: '/b', content: '2' }]);
		expect(fake.sandboxes.size).toBe(1);
		const only = [...fake.sandboxes.values()][0];
		expect(only.files.get('/a')).toBe('1');
		expect(only.files.get('/b')).toBe('2');
	});

	it('destroy reconnects by metadata when the instance has no cached handle', async () => {
		const fake = new FakeE2b();
		const compute = new E2bCompute(baseConfig, fake);
		await compute.create(SANDBOX_ID).writeFiles([{ path: '/a', content: '1' }]);

		await new E2bCompute(baseConfig, fake).create(SANDBOX_ID).destroy();

		expect([...fake.sandboxes.values()][0].killed).toBe(true);
	});

	it('exposePort returns the per-port public https URL', async () => {
		const fake = new FakeE2b();
		const sb = new E2bCompute(baseConfig, fake).create(SANDBOX_ID);
		const { url } = await sb.exposePort(2718, { hostname: 'ignored' });
		expect(url).toMatch(/^https:\/\/2718-e2b-\d+\.e2b\.app$/);
	});

	it('listActive returns only our owned sandboxes, mapped back to our SandboxId', async () => {
		const fake = new FakeE2b();
		const compute = new E2bCompute(baseConfig, fake);
		await compute.create(SANDBOX_ID).writeFiles([{ path: '/a', content: '1' }]);
		// A co-tenant sandbox (different owner) must be excluded.
		await fake.create({ metadata: { 'mh-owner': 'someone-else', 'mh-sandbox-id': 'sb-zzz' } });

		const active = await compute.listActive();
		expect(active).toEqual([{ id: SANDBOX_ID, createdAt: '2026-01-01T00:00:00Z' }]);
	});

	it('listActive drops malformed sandbox ids even when the owner tag matches', async () => {
		const fake = new FakeE2b();
		await fake.create({ metadata: { 'mh-owner': 'marimohub', 'mh-sandbox-id': 'e2b-native-id' } });

		await expect(new E2bCompute(baseConfig, fake).listActive()).resolves.toEqual([]);
	});

	it('mountBucket throws so the provisioner falls back to file copy', async () => {
		const sb = new E2bCompute(baseConfig, new FakeE2b()).create(SANDBOX_ID);
		await expect(
			sb.mountBucket({ bucketName: 'b', endpoint: 'e', mountPath: '/m', prefix: 'p' }),
		).rejects.toThrow();
	});

	it('destroy kills the sandbox', async () => {
		const fake = new FakeE2b();
		const sb = new E2bCompute(baseConfig, fake).create(SANDBOX_ID);
		await sb.writeFiles([{ path: '/a', content: '1' }]);
		await sb.destroy();
		expect([...fake.sandboxes.values()][0].killed).toBe(true);
	});

	it('readFile returns success:false when the SDK read throws', async () => {
		const res = await new E2bCompute(baseConfig, new FakeE2b())
			.create(SANDBOX_ID)
			.readFile('/missing.py');

		expect(res).toEqual({ success: false, content: '' });
	});

	it('exec reports success:false on a non-zero command result', async () => {
		const fake = new FakeE2b({ failOn: (cmd) => cmd === 'bad' });

		await expect(new E2bCompute(baseConfig, fake).create(SANDBOX_ID).exec('bad')).resolves.toEqual({
			success: false,
			stdout: '',
			stderr: 'fatal',
		});
	});

	it('execStream exposes stdout as a readable stream', async () => {
		const fake = new FakeE2b({
			runResult: (cmd) =>
				cmd === 'stream' ? { stdout: 'stream output', stderr: '', exitCode: 0 } : undefined,
		});

		const stream = await new E2bCompute(baseConfig, fake).create(SANDBOX_ID).execStream('stream');

		expect(await new Response(stream).text()).toBe('stream output');
	});

	it('passes accumulated environment variables to command runs and background processes', async () => {
		const fake = new FakeE2b({
			runResult: (cmd) =>
				cmd.startsWith('cat /tmp/marimohub-kernel.log')
					? { stdout: 'kernel log', stderr: '', exitCode: 0 }
					: undefined,
		});
		const sb = new E2bCompute(baseConfig, fake).create(SANDBOX_ID);

		await sb.setEnvVars({ TOKEN: 'abc' });
		await sb.setEnvVars({ MODE: 'prod' });
		await sb.exec('echo env');
		const proc = await sb.startProcess('uv run marimo edit app.py', { cwd: '/workspace' });
		expect(await proc.getLogs()).toEqual({ stdout: 'kernel log', stderr: '' });
		await proc.kill();

		expect(fake.runOptions.find((r) => r.cmd === 'echo env')?.options?.envs).toEqual({
			TOKEN: 'abc',
			MODE: 'prod',
		});
		expect(fake.backgroundCalls[0]).toMatchObject({
			cmd: 'uv run marimo edit app.py > /tmp/marimohub-kernel.log 2>&1',
			options: { cwd: '/workspace', envs: { TOKEN: 'abc', MODE: 'prod' } },
		});
		expect(fake.killedBackgroundCommands).toBe(1);
	});

	it('startProcess.waitForPort resolves once the in-sandbox probe succeeds', async () => {
		const fake = new FakeE2b();
		const sb = new E2bCompute(baseConfig, fake).create(SANDBOX_ID);
		const proc = await sb.startProcess('uv run marimo edit x.py --host 0.0.0.0 --port 2718');
		await expect(proc.waitForPort(2718, { timeout: 2000 })).resolves.toBeUndefined();
	});

	describe('listFiles()', () => {
		const findOutput = (lines: string[]) => `${lines.join('\n')}\n`;

		it('parses find output and filters hidden files', async () => {
			const fake = new FakeE2b({
				runResult: (cmd) =>
					cmd.includes('find')
						? {
								stdout: findOutput([
									'f\t10\t/workspace/a.py',
									'd\t4096\t/workspace/sub',
									'l\t0\t/workspace/link',
									'f\t5\t/workspace/.hidden',
								]),
								stderr: '',
								exitCode: 0,
							}
						: undefined,
			});
			const res = await new E2bCompute(baseConfig, fake).create(SANDBOX_ID).listFiles('/workspace');
			expectListFilesResult(res, {
				success: true,
				files: [
					{
						name: 'a.py',
						absolutePath: '/workspace/a.py',
						relativePath: 'a.py',
						type: 'file',
						size: 10,
					},
					{
						name: 'sub',
						absolutePath: '/workspace/sub',
						relativePath: 'sub',
						type: 'directory',
						size: 4096,
					},
					{
						name: 'link',
						absolutePath: '/workspace/link',
						relativePath: 'link',
						type: 'symlink',
						size: 0,
					},
				],
			});
		});

		it('includes hidden files when requested and omits maxdepth for recursive listings', async () => {
			const fake = new FakeE2b({
				runResult: (cmd) =>
					cmd.includes('find')
						? { stdout: findOutput(['f\t5\t/workspace/.hidden']), stderr: '', exitCode: 0 }
						: undefined,
			});
			const res = await new E2bCompute(baseConfig, fake)
				.create(SANDBOX_ID)
				.listFiles('/workspace', { recursive: true, includeHidden: true });
			expect(res.files.map((f) => f.name)).toEqual(['.hidden']);
			expect(fake.runCalls.find((c) => c.includes('find'))).not.toContain('-maxdepth 1');
		});

		it('returns success:false when find fails', async () => {
			const fake = new FakeE2b({
				runResult: (cmd) =>
					cmd.includes('find') ? { stdout: '', stderr: 'missing', exitCode: 1 } : undefined,
			});
			await expect(
				new E2bCompute(baseConfig, fake).create(SANDBOX_ID).listFiles('/workspace'),
			).resolves.toEqual({ success: false, files: [] });
		});
	});

	describe('gitCheckout', () => {
		it('runs a shell-quoted git clone (injection-safe via compute-commons)', async () => {
			const fake = new FakeE2b();
			await new E2bCompute(baseConfig, fake)
				.create(SANDBOX_ID)
				.gitCheckout('https://x/y', { branch: 'main', targetDir: 'w' });
			expect(fake.runCalls).toContain("git clone --branch 'main' 'https://x/y' 'w'");
		});

		it('throws when the clone fails', async () => {
			const fake = new FakeE2b({ failOn: (cmd) => cmd.includes('git clone') });
			await expect(
				new E2bCompute(baseConfig, fake).create(SANDBOX_ID).gitCheckout('https://x/y'),
			).rejects.toThrow(/git checkout failed/);
		});
	});
});

describe('createE2bClient', () => {
	it('surfaces CommandExitError-like SDK failures as command results', async () => {
		const sdk: E2bSdk = {
			Sandbox: {
				create: vi.fn(async () => ({
					sandboxId: 'e2b-1',
					commands: {
						run: vi.fn(async () => {
							throw Object.assign(new Error('command failed'), {
								exitCode: 7,
								stdout: 'out',
								stderr: 'err',
							});
						}),
					},
					files: { write: vi.fn(), read: vi.fn() },
					getHost: vi.fn(),
					kill: vi.fn(),
				})),
			},
		};
		const client = createE2bClient(baseConfig, async () => sdk);
		const sb = await client.create({});

		await expect(sb.commands.run('bad')).resolves.toEqual({
			stdout: 'out',
			stderr: 'err',
			exitCode: 7,
		});
	});

	it('wraps background commands with SDK kill and drains paginated list results', async () => {
		const kill = vi.fn(async () => {});
		const paginator = {
			hasNext: true,
			nextItems: vi.fn(async () => {
				paginator.hasNext = false;
				return [
					{
						sandboxId: 'e2b-1',
						startedAt: new Date('2026-01-01T00:00:00.000Z'),
						metadata: { a: 'b' },
					},
				];
			}),
		};
		const sdk: E2bSdk = {
			Sandbox: {
				connect: vi.fn(async () => ({
					sandboxId: 'e2b-1',
					commands: {
						run: vi.fn(async () => ({ pid: 'pid-1', stdout: '', stderr: '', exitCode: 0 })),
						kill,
					},
					files: { write: vi.fn(), read: vi.fn() },
					getHost: vi.fn((port: number) => `${port}-e2b-1.e2b.app`),
					kill: vi.fn(),
				})),
				list: vi.fn(() => paginator),
			},
		};
		const client = createE2bClient(baseConfig, async () => sdk);

		await expect(client.list()).resolves.toEqual([
			{
				sandboxId: 'e2b-1',
				startedAt: '2026-01-01T00:00:00.000Z',
				metadata: { a: 'b' },
			},
		]);
		const sb = await client.connect('e2b-1');
		const handle = await sb.commands.runBackground('sleep 1');
		await handle.kill();

		expect(paginator.nextItems).toHaveBeenCalledOnce();
		expect(kill).toHaveBeenCalledWith('pid-1');
		expect(sb.getHost(2718)).toBe('2718-e2b-1.e2b.app');
	});
});

computeContract('E2bCompute', () => new E2bCompute(baseConfig, new FakeE2b()), {
	mountFallsBack: true,
});
