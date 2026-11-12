import { describe, expect, it, vi } from 'vitest';
import { NOT_A_DIRECTORY_EXIT_CODE, NOT_A_DIRECTORY_MARKER } from '@marimo-hub/compute-commons';
import type { SandboxId } from '@marimo-hub/core/ids';
import {
	computeContract,
	isContractNonDirectoryFindCommand,
	scriptContractLaunch,
} from '@marimo-hub/core/testing/compute-contract';
import { BoxdCompute, createBoxdClient } from './index';
import type {
	BoxdClient,
	BoxdConfig,
	BoxdExecResult,
	BoxdExecStream,
	BoxdMachineInfo,
	BoxdSdk,
} from './index';

/**
 * Hermetic tests for the boxd adapter: an in-memory fake `BoxdClient` keyed by the
 * machine id it assigns, so reconnect-by-label, list and delete behave like boxd.
 */

const SANDBOX_ID = 'sb-aaaaaaaaaaaaaaaa' as SandboxId;
const baseConfig: BoxdConfig = { apiKey: 'key', snapshot: 'marimo-sandbox' };

interface FakeMachine {
	info: BoxdMachineInfo;
	files: Map<string, Uint8Array>;
	routes: Map<string, number>;
	deleted: boolean;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			if (text) controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

class FakeBoxd implements BoxdClient {
	readonly machines = new Map<string, FakeMachine>();
	readonly createCalls: {
		name: string;
		labels: Record<string, string>;
		snapshot?: string;
		deleteAfterSeconds?: number;
	}[] = [];
	readonly readyCalls: string[] = [];
	readonly execCalls: { id: string; argv: string[]; timeoutMs?: number }[] = [];
	readonly streamCalls: string[][] = [];
	readonly startCalls: string[] = [];
	readonly deleteCalls: string[] = [];
	closedStreams = 0;
	private seq = 0;
	private pid = 100;

	constructor(
		private readonly opts: {
			result?: (cmd: string) => BoxdExecResult | undefined;
			beforeCreate?: () => Promise<void>;
			failDelete?: boolean;
			failCreate?: () => Promise<void>;
		} = {},
	) {}

	private run(argv: string[]): BoxdExecResult {
		const cmd = argv.at(-1) ?? '';
		if (cmd.includes('setsid')) return { stdout: `${++this.pid}\n`, stderr: '', exitCode: 0 };
		if (cmd.includes('connect_ex')) return { stdout: '', stderr: '', exitCode: 0 };
		if (cmd.includes('mh-contract-fail')) return { stdout: '', stderr: 'fatal', exitCode: 1 };
		return this.opts.result?.(cmd) ?? { stdout: '', stderr: '', exitCode: 0 };
	}

	private live(id: string): FakeMachine {
		const m = this.machines.get(id);
		if (!m || m.deleted) throw new Error(`machine ${id} not found`);
		return m;
	}

	async create(options: {
		name: string;
		labels: Record<string, string>;
		snapshot?: string;
		deleteAfterSeconds?: number;
	}): Promise<BoxdMachineInfo> {
		await this.opts.beforeCreate?.();
		if (this.opts.failCreate) {
			this.createCalls.push(options);
			await this.opts.failCreate();
		}
		this.createCalls.push(options);
		const id = `m-${++this.seq}`;
		const info = {
			id,
			name: options.name,
			status: 'running',
			createdAt: '2026-01-01T00:00:00.000Z',
			labels: options.labels,
		};
		this.machines.set(id, { info, files: new Map(), routes: new Map(), deleted: false });
		return info;
	}

	async list(labels: Record<string, string>): Promise<BoxdMachineInfo[]> {
		return [...this.machines.values()]
			.filter((m) => !m.deleted)
			.filter((m) => Object.entries(labels).every(([k, v]) => m.info.labels[k] === v))
			.map((m) => m.info);
	}

	async start(id: string): Promise<BoxdMachineInfo> {
		this.startCalls.push(id);
		this.live(id).info.status = 'running';
		return this.live(id).info;
	}

	async waitUntilReady(id: string): Promise<BoxdMachineInfo> {
		this.readyCalls.push(id);
		this.live(id).info.status = 'running';
		return this.live(id).info;
	}

	async exec(id: string, argv: string[], options?: { timeoutMs?: number }) {
		this.live(id);
		this.execCalls.push({ id, argv, timeoutMs: options?.timeoutMs });
		if (argv[0] === 'test') {
			return { stdout: '', stderr: '', exitCode: this.live(id).files.has(argv[2]) ? 0 : 1 };
		}
		return this.run(argv);
	}

	execStream(id: string, argv: string[]): BoxdExecStream {
		this.live(id);
		this.streamCalls.push(argv);
		const res = this.run(argv);
		return {
			stdout: streamOf(res.stdout),
			stderr: streamOf(res.stderr),
			wait: async () => res.exitCode,
			close: () => {
				this.closedStreams += 1;
			},
		};
	}

	async upload(id: string, path: string, content: string | Uint8Array): Promise<void> {
		this.live(id).files.set(
			path,
			typeof content === 'string' ? new TextEncoder().encode(content) : content,
		);
	}

	async download(id: string, path: string): Promise<Uint8Array> {
		return this.live(id).files.get(path) ?? new Uint8Array();
	}

	async route(id: string, port: number, name?: string): Promise<string> {
		const m = this.live(id);
		m.routes.set(name ?? '', port);
		return `https://${name ? `${name}.` : ''}${m.info.name}.boxd.sh`;
	}

	async delete(id: string): Promise<void> {
		this.deleteCalls.push(id);
		if (this.opts.failDelete) throw new Error('delete refused');
		this.live(id).deleted = true;
	}
}

function lastCommand(fake: FakeBoxd): string {
	return fake.execCalls.at(-1)?.argv.at(-1) ?? '';
}

describe('BoxdCompute', () => {
	it('creates one labelled machine from the configured snapshot', async () => {
		const fake = new FakeBoxd();
		const compute = new BoxdCompute({ ...baseConfig, labels: { team: 'data' } }, fake);
		await compute.create(SANDBOX_ID).exec('true');
		expect(fake.createCalls).toEqual([
			{
				name: `marimohub-${SANDBOX_ID}`,
				labels: { team: 'data', 'mh-sandbox-id': SANDBOX_ID, 'mh-owner': 'marimohub' },
				snapshot: 'marimo-sandbox',
			},
		]);
	});

	it('honours the name prefix and owner tag', async () => {
		const fake = new FakeBoxd();
		const compute = new BoxdCompute(
			{ ...baseConfig, namePrefix: 'hub-a-', ownerTag: 'hub-a' },
			fake,
		);
		await compute.create(SANDBOX_ID).exec('true');
		expect(fake.createCalls[0].name).toBe(`hub-a-${SANDBOX_ID}`);
		expect(fake.createCalls[0].labels['mh-owner']).toBe('hub-a');
	});

	it('a per-create image override selects the snapshot', async () => {
		const fake = new FakeBoxd();
		const compute = new BoxdCompute(baseConfig, fake);
		await compute.create(SANDBOX_ID, { image: 'gpu-snapshot' }).exec('true');
		expect(fake.createCalls[0].snapshot).toBe('gpu-snapshot');
	});

	it('reuses the labelled machine instead of creating a second one', async () => {
		const fake = new FakeBoxd();
		await new BoxdCompute(baseConfig, fake).create(SANDBOX_ID).exec('true');
		await new BoxdCompute(baseConfig, fake).create(SANDBOX_ID).exec('true');
		expect(fake.createCalls).toHaveLength(1);
		expect(new Set(fake.execCalls.map((c) => c.id))).toEqual(new Set(['m-1']));
	});

	it('starts a stopped machine it owns rather than creating another', async () => {
		const fake = new FakeBoxd();
		await new BoxdCompute(baseConfig, fake).create(SANDBOX_ID).exec('true');
		fake.machines.get('m-1')!.info.status = 'stopped';
		await new BoxdCompute(baseConfig, fake).create(SANDBOX_ID).exec('true');
		expect(fake.startCalls).toEqual(['m-1']);
		expect(fake.createCalls).toHaveLength(1);
	});

	it.each(['missing', 'stopped', 'foreign'] as const)(
		'never creates or starts for a strict connection to a %s machine',
		async (state) => {
			const fake = new FakeBoxd();
			const compute = new BoxdCompute(baseConfig, fake);
			if (state === 'stopped') {
				await compute.create(SANDBOX_ID).exec('true');
				fake.machines.get('m-1')!.info.status = 'stopped';
			} else if (state === 'foreign') {
				await fake.create({
					name: 'other',
					labels: { 'mh-sandbox-id': SANDBOX_ID, 'mh-owner': 'other' },
				});
			}
			const count = fake.createCalls.length;
			const sandbox = new BoxdCompute(baseConfig, fake).connectExisting(SANDBOX_ID);
			await expect(sandbox.exec('true')).rejects.toThrow('no longer available');
			expect(fake.createCalls).toHaveLength(count);
			expect(fake.startCalls).toEqual([]);
		},
	);

	it('strictly reconnects to a running machine without creating', async () => {
		const fake = new FakeBoxd();
		const compute = new BoxdCompute(baseConfig, fake);
		await compute.create(SANDBOX_ID).writeFiles([{ path: '/workspace/a.py', content: 'saved' }]);
		const sandbox = new BoxdCompute(baseConfig, fake).connectExisting(SANDBOX_ID);
		expect(await sandbox.readFile('/workspace/a.py')).toMatchObject({
			success: true,
			content: 'saved',
			encoding: 'utf-8',
		});
		expect(fake.createCalls).toHaveLength(1);
	});

	it('does not reconnect to or destroy another owner machine with the same id', async () => {
		const fake = new FakeBoxd();
		await fake.create({
			name: 'other',
			labels: { 'mh-sandbox-id': SANDBOX_ID, 'mh-owner': 'other' },
		});
		const sandbox = new BoxdCompute(baseConfig, fake).create(SANDBOX_ID);
		await sandbox.exec('true');
		expect(fake.createCalls).toHaveLength(2);
		await sandbox.destroy();
		expect(fake.deleteCalls).toEqual(['m-2']);
		expect(fake.machines.get('m-1')!.deleted).toBe(false);
	});

	it('concurrent calls through separate instances provision exactly one machine', async () => {
		const fake = new FakeBoxd({ beforeCreate: () => new Promise((r) => setTimeout(r, 5)) });
		const compute = new BoxdCompute(baseConfig, fake);
		await Promise.all([
			compute.create(SANDBOX_ID).exec('true'),
			compute.create(SANDBOX_ID).exec('true'),
			compute.create(SANDBOX_ID).ready!(),
		]);
		expect(fake.createCalls).toHaveLength(1);
	});

	it('runs every command in a login shell with the forced and default env', async () => {
		const fake = new FakeBoxd();
		const sandbox = new BoxdCompute(baseConfig, fake).create(SANDBOX_ID);
		await sandbox.setEnvVars({ TOKEN: "a'b" });
		await sandbox.setEnvVars({ HOME_HINT: 'x' }, { onlyIfUnset: true });
		await sandbox.exec('echo hi', { timeout: 1234 });
		const call = fake.execCalls.at(-1)!;
		expect(call.argv.slice(0, 2)).toEqual(['sh', '-lc']);
		expect(call.argv[2]).toBe(
			`export TOKEN='a'\\''b'; [ -n "\${HOME_HINT+x}" ] || export HOME_HINT='x'; echo hi`,
		);
		expect(call.timeoutMs).toBe(1234);
	});

	it('exec reports success:false with output on a non-zero exit', async () => {
		const fake = new FakeBoxd({
			result: (cmd) =>
				cmd.endsWith('boom') ? { stdout: 'o', stderr: 'e', exitCode: 3 } : undefined,
		});
		const res = await new BoxdCompute(baseConfig, fake).create(SANDBOX_ID).exec('boom');
		expect(res).toEqual({
			success: false,
			stdout: 'o',
			stderr: 'e',
			error: { code: 'COMMAND_FAILED' },
		});
	});

	it('bounded exec streams the output and closes the stream', async () => {
		const fake = new FakeBoxd({
			result: (cmd) =>
				cmd.endsWith('big') ? { stdout: 'x'.repeat(64), stderr: '', exitCode: 0 } : undefined,
		});
		const sandbox = new BoxdCompute(baseConfig, fake).create(SANDBOX_ID);
		await expect(sandbox.exec('big', { maxOutputBytes: 16, timeout: 1000 })).rejects.toThrow(
			'exceeded byte limit',
		);
		expect(fake.closedStreams).toBe(1);
		await expect(sandbox.exec('small', { maxOutputBytes: 16 })).resolves.toMatchObject({
			success: true,
		});
		expect(fake.closedStreams).toBe(2);
	});

	it('readFile tells an empty file from a missing one', async () => {
		const fake = new FakeBoxd();
		const sandbox = new BoxdCompute(baseConfig, fake).create(SANDBOX_ID);
		expect(await sandbox.readFile('/workspace/missing.txt')).toMatchObject({
			success: false,
			error: { code: 'NOT_FOUND' },
		});
		expect(fake.execCalls.at(-1)!.argv).toEqual(['test', '-f', '/workspace/missing.txt']);
		await sandbox.writeFiles([{ path: '/workspace/empty.txt', content: '' }]);
		expect(await sandbox.readFile('/workspace/empty.txt')).toEqual({
			success: true,
			content: '',
			encoding: 'utf-8',
		});
	});

	it('readFile returns non-UTF-8 bytes as base64', async () => {
		const fake = new FakeBoxd();
		const sandbox = new BoxdCompute(baseConfig, fake).create(SANDBOX_ID);
		const bytes = new Uint8Array([0xff, 0x00, 0x80, 0x01]);
		await sandbox.writeFiles([{ path: '/workspace/b.bin', content: bytes }]);
		const read = await sandbox.readFile('/workspace/b.bin');
		expect(read).toMatchObject({ success: true, encoding: 'base64' });
		if (read.success) expect(Buffer.from(read.content, 'base64')).toEqual(Buffer.from(bytes));
	});

	it('writeFiles uploads bytes verbatim, never through argv', async () => {
		const fake = new FakeBoxd();
		const sandbox = new BoxdCompute(baseConfig, fake).create(SANDBOX_ID);
		const files = Array.from({ length: 20 }, (_, i) => ({
			path: `/workspace/f${i}.txt`,
			content: `content ${i}`,
		}));
		await sandbox.writeFiles(files);
		expect(fake.machines.get('m-1')!.files.size).toBe(20);
		expect(fake.execCalls).toHaveLength(1);
	});

	it('prepares the workdir once, right after create', async () => {
		const fake = new FakeBoxd();
		const sandbox = new BoxdCompute({ ...baseConfig, workdir: '/srv/nb' }, fake).create(SANDBOX_ID);
		await sandbox.exec('true');
		await sandbox.exec('true');
		expect(fake.execCalls[0].argv).toEqual([
			'sh',
			'-c',
			`sudo -n mkdir -p '/srv/nb' && sudo -n chown "$(id -u):$(id -g)" '/srv/nb'`,
		]);
		expect(fake.execCalls.filter((c) => c.argv.at(-1)?.includes('sudo'))).toHaveLength(1);
	});

	it('fails provisioning when the workdir cannot be prepared', async () => {
		const fake = new FakeBoxd({
			result: (cmd) =>
				cmd.includes('sudo -n') ? { stdout: '', stderr: 'denied', exitCode: 1 } : undefined,
		});
		await expect(new BoxdCompute(baseConfig, fake).create(SANDBOX_ID).exec('true')).rejects.toThrow(
			'workdir setup failed: denied',
		);
	});

	it('startProcess detaches the command and kills its process group', async () => {
		const fake = new FakeBoxd();
		const sandbox = new BoxdCompute(baseConfig, fake).create(SANDBOX_ID);
		await sandbox.setEnvVars({ A: '1' });
		const proc = await sandbox.startProcess('marimo edit', { cwd: '/workspace', env: { B: '2' } });
		const launch = lastCommand(fake);
		expect(fake.execCalls.at(-1)!.argv.slice(0, 2)).toEqual(['sh', '-c']);
		expect(launch).toContain('setsid sh -lc');
		expect(launch).toContain(
			"export A='\\''1'\\''; export B='\\''2'\\''; cd '\\''/workspace'\\'' && marimo edit",
		);
		expect(launch).toMatch(/< \/dev\/null > \/dev\/null 2>&1 & echo \$!$/);
		await proc.kill('SIGKILL');
		expect(lastCommand(fake)).toContain('kill -KILL -- -101');
		await proc.kill('nonsense; rm -rf /');
		expect(lastCommand(fake)).toContain('kill -TERM -- -101');
	});

	it('startProcess.waitForPort resolves once the in-machine probe succeeds', async () => {
		const sandbox = new BoxdCompute(baseConfig, new FakeBoxd()).create(SANDBOX_ID);
		const proc = await sandbox.startProcess('marimo edit');
		await expect(proc.waitForPort(2718, { timeout: 1000 })).resolves.toBeUndefined();
	});

	it('exposes the kernel on the default route and other ports on named routes', async () => {
		const fake = new FakeBoxd();
		const sandbox = new BoxdCompute(baseConfig, fake).create(SANDBOX_ID);
		expect((await sandbox.exposePort(2718, { hostname: '' })).url).toBe(
			`https://marimohub-${SANDBOX_ID}.boxd.sh`,
		);
		expect((await sandbox.exposePort(8443, { hostname: '' })).url).toBe(
			`https://p8443.marimohub-${SANDBOX_ID}.boxd.sh`,
		);
		expect(Object.fromEntries(fake.machines.get('m-1')!.routes)).toEqual({ '': 2718, p8443: 8443 });
	});

	it('listActive returns only owned machines with well-formed ids', async () => {
		const fake = new FakeBoxd();
		const compute = new BoxdCompute(baseConfig, fake);
		await compute.create(SANDBOX_ID).exec('true');
		await fake.create({ name: 'x', labels: { 'mh-sandbox-id': 'bad', 'mh-owner': 'marimohub' } });
		await fake.create({
			name: 'y',
			labels: { 'mh-sandbox-id': 'sb-bbbbbbbbbbbbbbbb', 'mh-owner': 'other' },
		});
		expect(await compute.listActive()).toEqual([
			{ id: SANDBOX_ID, createdAt: '2026-01-01T00:00:00.000Z' },
		]);
	});

	it('listActive includes stopped and failed machines so the reconciler can reap them', async () => {
		const fake = new FakeBoxd();
		const compute = new BoxdCompute(baseConfig, fake);
		await compute.create(SANDBOX_ID).exec('true');
		fake.machines.get('m-1')!.info.status = 'stopped';
		const other = 'sb-bbbbbbbbbbbbbbbb';
		await fake.create({ name: 'f', labels: { 'mh-sandbox-id': other, 'mh-owner': 'marimohub' } });
		fake.machines.get('m-2')!.info.status = 'failed';
		await fake.create({
			name: 'd',
			labels: { 'mh-sandbox-id': 'sb-cccccccccccccccc', 'mh-owner': 'marimohub' },
		});
		fake.machines.get('m-3')!.info.status = 'destroyed';
		expect((await compute.listActive()).map((s) => s.id)).toEqual([SANDBOX_ID, other]);
	});

	it('deletes a failed machine before creating its replacement', async () => {
		const fake = new FakeBoxd();
		await new BoxdCompute(baseConfig, fake).create(SANDBOX_ID).exec('true');
		fake.machines.get('m-1')!.info.status = 'failed';
		await new BoxdCompute(baseConfig, fake).create(SANDBOX_ID).exec('true');
		expect(fake.deleteCalls).toEqual(['m-1']);
		expect(fake.createCalls).toHaveLength(2);
	});

	it('waits for a machine that is still starting before using it', async () => {
		const fake = new FakeBoxd();
		await new BoxdCompute(baseConfig, fake).create(SANDBOX_ID).exec('true');
		fake.machines.get('m-1')!.info.status = 'starting';
		await new BoxdCompute(baseConfig, fake).create(SANDBOX_ID).exec('true');
		expect(fake.readyCalls).toEqual(['m-1']);
		expect(fake.createCalls).toHaveLength(1);
	});

	it('adopts the machine another replica created when create conflicts', async () => {
		const fake = new FakeBoxd();
		const winner = await fake.create({
			name: `marimohub-${SANDBOX_ID}`,
			labels: { 'mh-sandbox-id': SANDBOX_ID, 'mh-owner': 'marimohub' },
		});
		const listed = fake.list.bind(fake);
		let first = true;
		fake.list = async (labels) => {
			if (first) {
				first = false;
				return [];
			}
			return listed(labels);
		};
		const racing = new FakeBoxd({
			failCreate: async () => {
				throw new Error('name taken');
			},
		});
		racing.list = fake.list;
		racing.exec = fake.exec.bind(fake);
		await new BoxdCompute(baseConfig, racing).create(SANDBOX_ID).exec('true');
		expect(fake.execCalls.at(-1)!.id).toBe(winner.id);
	});

	it('deletes the new machine when the workdir cannot be prepared', async () => {
		const fake = new FakeBoxd({
			result: (cmd) =>
				cmd.includes('sudo -n') ? { stdout: '', stderr: 'denied', exitCode: 1 } : undefined,
		});
		await expect(new BoxdCompute(baseConfig, fake).create(SANDBOX_ID).exec('true')).rejects.toThrow(
			'workdir setup failed',
		);
		expect(fake.deleteCalls).toEqual(['m-1']);
	});

	it('passes the lifetime cap to create', async () => {
		const fake = new FakeBoxd();
		await new BoxdCompute({ ...baseConfig, maxLifetimeSeconds: 7200 }, fake)
			.create(SANDBOX_ID)
			.exec('true');
		expect(fake.createCalls[0].deleteAfterSeconds).toBe(7200);
	});

	it('execStream closes the remote exec when the reader cancels', async () => {
		const fake = new FakeBoxd({
			result: (cmd) =>
				cmd.endsWith('tail') ? { stdout: 'line\n', stderr: '', exitCode: 0 } : undefined,
		});
		const sandbox = new BoxdCompute(baseConfig, fake).create(SANDBOX_ID);
		const stream = await sandbox.execStream('tail');
		const reader = stream.getReader();
		await reader.read();
		await reader.cancel();
		expect(fake.closedStreams).toBe(1);
	});

	it('destroy treats a machine listed as destroyed as gone', async () => {
		const fake = new FakeBoxd({ failDelete: true });
		const sandbox = new BoxdCompute(baseConfig, fake).create(SANDBOX_ID);
		await sandbox.exec('true');
		fake.machines.get('m-1')!.info.status = 'destroyed';
		await expect(sandbox.destroy()).resolves.toBeUndefined();
	});

	it('destroy deletes every machine carrying our id', async () => {
		const fake = new FakeBoxd();
		const compute = new BoxdCompute(baseConfig, fake);
		const sandbox = compute.create(SANDBOX_ID);
		await sandbox.exec('true');
		await fake.create({
			name: 'dup',
			labels: { 'mh-sandbox-id': SANDBOX_ID, 'mh-owner': 'marimohub' },
		});
		await sandbox.destroy();
		expect(fake.deleteCalls.sort()).toEqual(['m-1', 'm-2']);
		expect(await compute.listActive()).toEqual([]);
	});

	it('destroy propagates a failed delete while the machine still exists', async () => {
		const fake = new FakeBoxd({ failDelete: true });
		const sandbox = new BoxdCompute(baseConfig, fake).create(SANDBOX_ID);
		await sandbox.exec('true');
		await expect(sandbox.destroy()).rejects.toThrow('delete refused');
	});

	it('waits for destroy before provisioning a replacement', async () => {
		const fake = new FakeBoxd();
		const compute = new BoxdCompute(baseConfig, fake);
		const sandbox = compute.create(SANDBOX_ID);
		await sandbox.exec('true');
		const destroying = sandbox.destroy();
		await compute.create(SANDBOX_ID).exec('true');
		await destroying;
		expect(fake.createCalls).toHaveLength(2);
		expect(fake.machines.get('m-1')!.deleted).toBe(true);
		expect(fake.machines.get('m-2')!.deleted).toBe(false);
	});

	it('mountBucket throws so the provisioner falls back to file copy', async () => {
		const sandbox = new BoxdCompute(baseConfig, new FakeBoxd()).create(SANDBOX_ID);
		await expect(
			sandbox.mountBucket({ bucketName: 'b', mountPath: '/mnt', prefix: '' }),
		).rejects.toThrow('file copy');
	});
});

describe('createBoxdClient', () => {
	function fakeSdk() {
		const calls: { method: string; args: unknown[] }[] = [];
		const record =
			(method: string, result?: unknown) =>
			async (...args: unknown[]) => {
				calls.push({ method, args });
				return typeof result === 'function'
					? (result as (...a: unknown[]) => unknown)(...args)
					: result;
			};
		const machine = {
			id: 'm-1',
			name: 'marimohub-sb',
			status: 'running',
			createdAt: new Date('2026-01-01T00:00:00Z'),
			labels: { a: 'b' },
		};
		const proxies = [
			{ name: null, isDefault: true, domain: 'marimohub-sb.boxd.sh', port: 2718 },
			{ name: 'p8443', isDefault: false, domain: 'p8443.marimohub-sb.boxd.sh', port: 8443 },
		];
		class NotFoundError extends Error {
			override name = 'NotFoundError';
		}
		const machines = {
			create: record('create', { id: 'm-1' }),
			waitUntilReady: record('waitUntilReady', machine),
			list: record('list', Object.assign([machine], { elsewhere: {} })),
			start: record('start'),
			exec: record('exec', { stdout: 'out', stderr: '', exitCode: 0 }),
			delete: record('delete', () => {
				throw new NotFoundError('gone');
			}),
			setBotProtection: record('setBotProtection'),
			files: { upload: record('upload', 3), download: record('download', new Uint8Array([1])) },
			proxies: {
				list: record('proxies.list', proxies),
				create: record('proxies.create'),
				setPort: record('proxies.setPort'),
			},
		};
		const options: unknown[] = [];
		const sdk: BoxdSdk = {
			Boxd: class {
				machines = machines;
				constructor(opts: unknown) {
					options.push(opts);
				}
			},
			NotFoundError,
		};
		return { sdk, calls, options };
	}

	it('creates isolated machines in the configured org and region, then waits for readiness', async () => {
		const { sdk, calls, options } = fakeSdk();
		const client = createBoxdClient({ apiKey: 'key', org: 'acme', region: 'fra' }, async () => sdk);
		const info = await client.create({ name: 'n', labels: { a: 'b' }, snapshot: 'snap' });
		expect(options).toEqual([{ apiKey: 'key', region: 'fra' }]);
		expect(calls[0]).toEqual({
			method: 'create',
			args: [{ name: 'n', labels: { a: 'b' }, isolated: true, org: 'acme', fromSnapshot: 'snap' }],
		});
		expect(calls[1]).toEqual({ method: 'waitUntilReady', args: ['m-1'] });
		expect(info).toEqual({
			id: 'm-1',
			name: 'marimohub-sb',
			status: 'running',
			createdAt: '2026-01-01T00:00:00.000Z',
			labels: { a: 'b' },
		});
		await client.list({ x: 'y' });
		expect(calls.at(-1)).toEqual({ method: 'list', args: [{ org: 'acme', labels: { x: 'y' } }] });
	});

	it('deletes a created machine that never becomes ready, and passes deleteAfter', async () => {
		const { sdk, calls } = fakeSdk();
		const machines = new sdk.Boxd({}).machines;
		machines.waitUntilReady = async (...args: unknown[]) => {
			calls.push({ method: 'waitUntilReady', args });
			throw new Error('not ready in time');
		};
		const client = createBoxdClient({ apiKey: 'key' }, async () => sdk);
		await expect(client.create({ name: 'n', labels: {}, deleteAfterSeconds: 600 })).rejects.toThrow(
			'not ready in time',
		);
		expect(calls[0].args[0]).toMatchObject({ deleteAfter: 600 });
		expect(calls.map((c) => c.method)).toEqual(['create', 'waitUntilReady', 'delete']);
	});

	it('routes the kernel on the default route with bot protection off', async () => {
		const { sdk, calls } = fakeSdk();
		const client = createBoxdClient({ apiKey: 'key' }, async () => sdk);
		expect(await client.route('m-1', 2718)).toBe('https://marimohub-sb.boxd.sh');
		expect(calls.map((c) => c.method)).toEqual([
			'proxies.setPort',
			'setBotProtection',
			'proxies.list',
		]);
		expect(calls[1].args).toEqual(['m-1', 'off']);
	});

	it('reuses an existing named route and creates a missing one', async () => {
		const { sdk, calls } = fakeSdk();
		const client = createBoxdClient({ apiKey: 'key' }, async () => sdk);
		expect(await client.route('m-1', 8443, 'p8443')).toBe('https://p8443.marimohub-sb.boxd.sh');
		expect(calls.map((c) => c.method)).toEqual(['proxies.list', 'proxies.list']);
		await expect(client.route('m-1', 9000, 'p9000')).rejects.toThrow('was not created');
		expect(calls.find((c) => c.method === 'proxies.create')?.args).toEqual(['m-1', 'p9000', 9000]);
	});

	it('passes argv and a millisecond timeout to exec', async () => {
		const { sdk, calls } = fakeSdk();
		const client = createBoxdClient({ apiKey: 'key' }, async () => sdk);
		expect(await client.exec('m-1', ['sh', '-lc', 'x'], { timeoutMs: 500 })).toEqual({
			stdout: 'out',
			stderr: '',
			exitCode: 0,
		});
		expect(calls[0].args).toEqual(['m-1', { command: ['sh', '-lc', 'x'], timeout: 500 }]);
	});

	it('treats deleting an already-deleted machine as done', async () => {
		const { sdk } = fakeSdk();
		const client = createBoxdClient({ apiKey: 'key' }, async () => sdk);
		await expect(client.delete('m-1')).resolves.toBeUndefined();
	});

	it('refuses to build a client without an API key', () => {
		const load = vi.fn();
		expect(() => createBoxdClient({ apiKey: ' ' }, load)).toThrow('requires an API key');
		expect(load).not.toHaveBeenCalled();
	});

	it('surfaces a loadSdk failure', async () => {
		const client = createBoxdClient({ apiKey: 'key' }, async () => {
			throw new Error('missing @boxd-sh/sdk');
		});
		await expect(client.list({})).rejects.toThrow('missing @boxd-sh/sdk');
	});

	it('loads the SDK once per client', async () => {
		const { sdk } = fakeSdk();
		const load = vi.fn(async () => sdk);
		const client = createBoxdClient({ apiKey: 'key' }, load);
		await client.list({});
		await client.exec('m-1', ['true']);
		expect(load).toHaveBeenCalledOnce();
	});
});

computeContract(
	'BoxdCompute',
	() => {
		const state: { fake?: FakeBoxd } = {};
		const fake = new FakeBoxd({
			result: (cmd) => {
				if (cmd.startsWith('cat /tmp/marimohub-')) {
					const launch = scriptContractLaunch(
						state.fake?.execCalls
							.filter((c) => c.argv.at(-1)?.includes('setsid'))
							.at(-1)
							?.argv.at(-1),
					);
					if (launch) return { stdout: launch.transcript, stderr: '', exitCode: 0 };
				}
				return isContractNonDirectoryFindCommand(cmd)
					? { stdout: '', stderr: NOT_A_DIRECTORY_MARKER, exitCode: NOT_A_DIRECTORY_EXIT_CODE }
					: undefined;
			},
		});
		state.fake = fake;
		return new BoxdCompute(baseConfig, fake);
	},
	{
		mountFallsBack: true,
		secondaryPort: 8443,
		semantics: {
			failingCommand: 'mh-contract-fail',
			launch: {},
			absentFile: { path: '/contract-absent.txt', code: 'NOT_FOUND' },
		},
	},
);
