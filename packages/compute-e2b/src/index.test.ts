import { describe, it, expect } from 'vitest';
import type { SandboxId } from '@marimo-hub/core';
import { computeContract } from '@marimo-hub/core/testing/compute-contract';
import { E2bCompute } from './index';
import type { E2bClient, E2bConfig, E2bSandboxHandle, E2bSandboxInfo } from './index';

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
	readonly runCalls: string[] = [];
	private seq = 0;

	constructor(private readonly opts: { failOn?: (cmd: string) => boolean } = {}) {}

	private makeHandle(sb: FakeSandbox): E2bSandboxHandle {
		return {
			sandboxId: sb.info.sandboxId,
			commands: {
				run: async (cmd) => {
					this.runCalls.push(cmd);
					// Make the in-sandbox port probe "succeed" so waitForPort resolves fast.
					if (cmd.includes('connect_ex')) return { stdout: '', stderr: '', exitCode: 0 };
					if (this.opts.failOn?.(cmd)) return { stdout: '', stderr: 'fatal', exitCode: 1 };
					return { stdout: '', stderr: '', exitCode: 0 };
				},
				runBackground: async () => ({ kill: async () => {} }),
			},
			files: {
				write: async (path, content) => void sb.files.set(path, content),
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
		await sb.writeFile('/home/appuser/notebooks/notebook.py', 'print(1)\n');

		const created = [...fake.sandboxes.values()][0];
		expect(created.info.metadata?.['mh-sandbox-id']).toBe(SANDBOX_ID);
		expect(created.info.metadata?.['mh-owner']).toBe('marimohub');
		expect(created.files.get('/home/appuser/notebooks/notebook.py')).toBe('print(1)\n');
	});

	it('reuses the existing sandbox (reconnect by metadata tag), not a second create', async () => {
		const fake = new FakeE2b();
		const compute = new E2bCompute(baseConfig, fake);
		await compute.create(SANDBOX_ID).writeFile('/a', '1');
		// A fresh instance for the same id must find + reuse the live sandbox.
		await compute.create(SANDBOX_ID).writeFile('/b', '2');
		expect(fake.sandboxes.size).toBe(1);
		const only = [...fake.sandboxes.values()][0];
		expect(only.files.get('/a')).toBe('1');
		expect(only.files.get('/b')).toBe('2');
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
		await compute.create(SANDBOX_ID).writeFile('/a', '1');
		// A co-tenant sandbox (different owner) must be excluded.
		await fake.create({ metadata: { 'mh-owner': 'someone-else', 'mh-sandbox-id': 'sb-zzz' } });

		const active = await compute.listActive();
		expect(active).toEqual([{ id: SANDBOX_ID, createdAt: '2026-01-01T00:00:00Z' }]);
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
		await sb.writeFile('/a', '1');
		await sb.destroy();
		expect([...fake.sandboxes.values()][0].killed).toBe(true);
	});

	it('startProcess.waitForPort resolves once the in-sandbox probe succeeds', async () => {
		const fake = new FakeE2b();
		const sb = new E2bCompute(baseConfig, fake).create(SANDBOX_ID);
		const proc = await sb.startProcess('uv run marimo edit x.py --host 0.0.0.0 --port 2718');
		await expect(proc.waitForPort(2718, { timeout: 2000 })).resolves.toBeUndefined();
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

computeContract('E2bCompute', () => new E2bCompute(baseConfig, new FakeE2b()), {
	mountFallsBack: true,
});
