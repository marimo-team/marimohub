import { describe, expect, it } from 'vitest';
import { NotFoundError, SandboxFilesystemNotADirectoryError } from 'modal';
import type { SandboxId } from '@marimo-hub/core';
import { listFilesFailure } from '@marimo-hub/core/ports';
import { expectExecResult, expectFileResult } from '@marimo-hub/core/testing';
import {
	computeContract,
	CONTRACT_HIDDEN_FILE,
	CONTRACT_VISIBLE_FILE,
} from '@marimo-hub/core/testing/compute-contract';
import { modalProfileResources, ModalCompute } from './index';
import type {
	ModalClientLike,
	ModalFileInfoLike,
	ModalProcessLike,
	ModalSandboxLike,
} from './index';

const SANDBOX_ID = 'sb-abc' as SandboxId;

function textStream(value: string): ReadableStream<string> {
	return new ReadableStream({
		start(controller) {
			if (value) controller.enqueue(value);
			controller.close();
		},
	});
}

function processResult(exitCode = 0, stdout = '', stderr = ''): ModalProcessLike {
	return {
		stdout: textStream(stdout),
		stderr: textStream(stderr),
		wait: async () => exitCode,
	};
}

function pendingProcessResult(): {
	process: ModalProcessLike;
	resolve: (exitCode: number) => void;
} {
	let resolve = (_exitCode: number) => {};
	const wait = new Promise<number>((resolveWait) => {
		resolve = resolveWait;
	});
	return {
		process: {
			stdout: textStream(''),
			stderr: textStream(''),
			wait: () => wait,
		},
		resolve,
	};
}

class FakeSandbox implements ModalSandboxLike {
	readonly files = new Map<string, string | Uint8Array>();
	readonly directories = new Map<string, ModalFileInfoLike[]>();
	readonly execCalls: {
		command: string[];
		options?: Parameters<ModalSandboxLike['exec']>[1];
	}[] = [];
	readonly tags: Record<string, string>;
	terminated = false;
	execImpl: (command: string[]) => ModalProcessLike = () => processResult();

	constructor(tags: Record<string, string> = {}) {
		this.tags = tags;
	}

	private writeFile(path: string, content: string | Uint8Array): void {
		this.files.set(path, content);
		const separator = path.lastIndexOf('/');
		const directory = separator === 0 ? '/' : path.slice(0, separator);
		const name = path.slice(separator + 1);
		const entries = this.directories.get(directory) ?? [];
		const entry = { name, path, type: 'file' as const, size: content.length };
		const existing = entries.findIndex((candidate) => candidate.path === path);
		if (existing === -1) entries.push(entry);
		else entries[existing] = entry;
		this.directories.set(directory, entries);
	}

	filesystem = {
		readText: async (path: string) => {
			const value = this.files.get(path);
			if (typeof value !== 'string') throw new Error('not found');
			return value;
		},
		writeText: async (content: string, path: string) => {
			this.writeFile(path, content);
		},
		writeBytes: async (content: Uint8Array, path: string) => {
			this.writeFile(path, content);
		},
		listFiles: async (path: string) => {
			if (this.files.has(path)) {
				throw new SandboxFilesystemNotADirectoryError(`${path} is not a directory`);
			}
			return this.directories.get(path) ?? [];
		},
	};

	async exec(
		command: string[],
		options?: Parameters<ModalSandboxLike['exec']>[1],
	): Promise<ModalProcessLike> {
		this.execCalls.push({ command, options });
		return this.execImpl(command);
	}

	async getTags(): Promise<Record<string, string>> {
		return this.tags;
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	async tunnels(): Promise<Record<number, { url: string }>> {
		return { 2718: { url: 'https://sandbox.modal.host' } };
	}
}

function makeWorld() {
	const existing = new Map<string, FakeSandbox>();
	const listed: FakeSandbox[] = [];
	const created: {
		app: unknown;
		image: unknown;
		options: Parameters<ModalClientLike['sandboxes']['create']>[2];
		sandbox: FakeSandbox;
	}[] = [];
	const appCalls: { name: string; options?: { createIfMissing?: boolean } }[] = [];
	const imageCalls: string[] = [];

	const client: ModalClientLike = {
		apps: {
			async fromName(name, options) {
				appCalls.push({ name, options });
				return { appId: `ap-${name}` };
			},
		},
		images: {
			fromRegistry(image) {
				imageCalls.push(image);
				return { image };
			},
		},
		sandboxes: {
			async create(app, image, options) {
				const sandbox = new FakeSandbox(options.tags);
				existing.set(options.name, sandbox);
				created.push({ app, image, options, sandbox });
				return sandbox;
			},
			async fromName(_appName, name) {
				const sandbox = existing.get(name);
				if (!sandbox) throw new NotFoundError('missing');
				return sandbox;
			},
			async *list() {
				yield* listed;
			},
		},
	};

	return { client, existing, listed, created, appCalls, imageCalls };
}

function makeCompute(world: ReturnType<typeof makeWorld>, overrides = {}) {
	return new ModalCompute(
		{
			tokenId: 'token-id',
			tokenSecret: 'token-secret',
			image: 'ghcr.io/acme/marimo:latest',
			appName: 'hub-app',
			idleFallbackMs: 45 * 60_000,
			...overrides,
		},
		world.client,
	);
}

describe('ModalCompute', () => {
	it('configures the SDK client for the selected Modal environment', () => {
		const compute = new ModalCompute({
			tokenId: 'token-id',
			tokenSecret: 'token-secret',
			image: 'ghcr.io/acme/marimo:latest',
			environment: 'notebooks',
		});
		const client = Reflect.get(compute, 'client') as { profile: { environment?: string } };

		expect(client.profile.environment).toBe('notebooks');
	});

	it('creates fresh sandboxes through the supported SDK with profile resources', async () => {
		const world = makeWorld();
		await makeCompute(world)
			.create(SANDBOX_ID, {
				reuse: false,
				resources: { cpu: 1.5, memoryBytes: 2 * 1024 ** 3, gpu: 'A100:2' },
			})
			.exec('true');

		expect(world.created).toHaveLength(1);
		expect(world.created[0].options).toMatchObject({
			name: SANDBOX_ID,
			cpu: 1.5,
			memoryMiB: 2048,
			gpu: 'A100:2',
			encryptedPorts: [2718],
			idleTimeoutMs: 45 * 60_000,
			timeoutMs: 24 * 60 * 60_000,
			tags: {
				'marimohub.owner': 'hub-app',
				'marimohub.sandbox-id': SANDBOX_ID,
			},
		});
		expect(world.imageCalls).toEqual(['ghcr.io/acme/marimo:latest']);
		expect(world.created[0].sandbox.execCalls[0].command).toEqual(['sh', '-lc', 'true']);
	});

	it('pins an idle main process so the image entrypoint cannot boot its own marimo', async () => {
		const world = makeWorld();
		await makeCompute(world).create(SANDBOX_ID, { reuse: false }).exec('true');
		expect(world.created[0].options.command).toEqual(['sleep', 'infinity']);
	});

	it('keeps unset resources as an exact create-options no-op', async () => {
		expect(modalProfileResources(undefined)).toEqual({});
		expect(modalProfileResources({ cpu: 0.5, memoryBytes: 512 * 1024 ** 2 })).toEqual({
			cpu: 0.5,
			memoryMiB: 512,
		});
		expect(modalProfileResources({ gpu: 'T4:2' })).toEqual({ gpu: 'T4:2' });

		const world = makeWorld();
		await makeCompute(world).create(SANDBOX_ID, { reuse: false }).exec('true');
		expect(world.created[0].options).not.toHaveProperty('cpu');
		expect(world.created[0].options).not.toHaveProperty('memoryMiB');
		expect(world.created[0].options).not.toHaveProperty('gpu');
	});

	it('reattaches by sandbox name when reuse is enabled', async () => {
		const world = makeWorld();
		const existing = new FakeSandbox();
		world.existing.set(SANDBOX_ID, existing);

		await makeCompute(world).create(SANDBOX_ID).exec('echo hi');

		expect(world.created).toHaveLength(0);
		expect(existing.execCalls[0].command).toEqual(['sh', '-lc', 'echo hi']);
	});

	it('creates on a reuse lookup miss', async () => {
		const world = makeWorld();
		await makeCompute(world).create(SANDBOX_ID).exec('true');
		expect(world.created).toHaveLength(1);
	});

	it('maps process output and passes accumulated environment variables', async () => {
		const world = makeWorld();
		const sandbox = new FakeSandbox();
		sandbox.execImpl = () => processResult(3, 'out', 'err');
		world.existing.set(SANDBOX_ID, sandbox);
		const instance = makeCompute(world).create(SANDBOX_ID);
		await instance.setEnvVars({ A: '1' });
		await instance.setEnvVars({ B: '2' });

		const result = await instance.exec('run');

		expectExecResult(result, { success: false, stdout: 'out', stderr: 'err' });
		expect(sandbox.execCalls[0].options?.env).toEqual({ A: '1', B: '2' });
	});

	it('applies onlyIfUnset vars as a guarded prefix, not exec env', async () => {
		const world = makeWorld();
		const sandbox = new FakeSandbox();
		sandbox.execImpl = () => processResult(0, '', '');
		world.existing.set(SANDBOX_ID, sandbox);
		const instance = makeCompute(world).create(SANDBOX_ID);
		await instance.setEnvVars({ A: '1' });
		await instance.setEnvVars({ CACHE: '/tmp/c' }, { onlyIfUnset: true });

		await instance.exec('run');

		expect(sandbox.execCalls[0].command).toEqual([
			'sh',
			'-lc',
			'[ -n "${CACHE:-}" ] || export CACHE=\'/tmp/c\'; run',
		]);
		expect(sandbox.execCalls[0].options?.env).toEqual({ A: '1' });

		await instance.startProcess('serve');
		const started = sandbox.execCalls.at(-1)!;
		expect(started.command[2].startsWith('[ -n "${CACHE:-}" ] || export CACHE=\'/tmp/c\'; ')).toBe(
			true,
		);
		expect(started.options?.env).toEqual({ A: '1' });
	});

	it('streams raw stdout without enabling PTY mode', async () => {
		const world = makeWorld();
		const sandbox = new FakeSandbox();
		sandbox.execImpl = () => processResult(0, 'raw\r\nstdout', 'separate stderr');
		world.existing.set(SANDBOX_ID, sandbox);

		const stream = await makeCompute(world).create(SANDBOX_ID).execStream('run');
		const reader = stream.getReader();

		expect(await reader.read()).toEqual({ done: false, value: 'raw\r\nstdout' });
		expect(sandbox.execCalls[0].options).not.toHaveProperty('pty');
	});

	it('reads and writes text and binary files through the SDK filesystem', async () => {
		const world = makeWorld();
		const sandbox = new FakeSandbox();
		sandbox.files.set('/workspace/in.txt', 'hello');
		world.existing.set(SANDBOX_ID, sandbox);
		const instance = makeCompute(world).create(SANDBOX_ID);

		expectFileResult(await instance.readFile('/workspace/in.txt'), {
			success: true,
			content: 'hello',
		});
		await instance.writeFiles([
			{ path: '/workspace/out.txt', content: 'text' },
			{ path: '/workspace/out.bin', content: new Uint8Array([0xff, 0x00]) },
		]);
		expect(sandbox.files.get('/workspace/out.txt')).toBe('text');
		expect(sandbox.files.get('/workspace/out.bin')).toEqual(new Uint8Array([0xff, 0x00]));
	});

	it('lists recursively while respecting hidden-file filtering', async () => {
		const world = makeWorld();
		const sandbox = new FakeSandbox();
		sandbox.directories.set('/workspace', [
			{ name: 'a.py', path: '/workspace/a.py', type: 'file', size: 5 },
			{ name: '.hidden', path: '/workspace/.hidden', type: 'file', size: 1 },
			{ name: 'sub', path: '/workspace/sub', type: 'directory', size: 0 },
		]);
		sandbox.directories.set('/workspace/sub', [
			{ name: 'b.py', path: '/workspace/sub/b.py', type: 'file', size: 7 },
		]);
		world.existing.set(SANDBOX_ID, sandbox);

		const result = await makeCompute(world)
			.create(SANDBOX_ID)
			.listFiles('/workspace', { recursive: true });

		expect(result.files.map((file) => file.relativePath)).toEqual(['a.py', 'sub', 'sub/b.py']);
		expect(sandbox.execCalls).toEqual([]);
	});

	it('returns NOT_A_DIRECTORY when the SDK rejects a file path', async () => {
		const world = makeWorld();
		const sandbox = new FakeSandbox();
		sandbox.files.set('/workspace/notebook.py', 'print(1)');
		world.existing.set(SANDBOX_ID, sandbox);

		await expect(
			makeCompute(world).create(SANDBOX_ID).listFiles('/workspace/notebook.py'),
		).resolves.toEqual(listFilesFailure('NOT_A_DIRECTORY'));
		expect(sandbox.execCalls).toEqual([]);
	});

	it('returns BACKEND_ERROR when the SDK listing throws', async () => {
		const world = makeWorld();
		const sandbox = new FakeSandbox();
		sandbox.filesystem.listFiles = async () => {
			throw new Error('boom');
		};
		world.existing.set(SANDBOX_ID, sandbox);

		await expect(makeCompute(world).create(SANDBOX_ID).listFiles('/workspace')).resolves.toEqual(
			listFilesFailure('BACKEND_ERROR'),
		);
	});

	it('exposes the SDK tunnel and terminates the named sandbox', async () => {
		const world = makeWorld();
		const sandbox = new FakeSandbox();
		world.existing.set(SANDBOX_ID, sandbox);
		const instance = makeCompute(world).create(SANDBOX_ID);

		expect(await instance.exposePort(2718, { hostname: '' })).toEqual({
			url: 'https://sandbox.modal.host',
		});
		await instance.destroy();
		expect(sandbox.terminated).toBe(true);
	});

	it('kills a started process by its tracked PID rather than matching its command', async () => {
		const world = makeWorld();
		const sandbox = new FakeSandbox();
		const pending = pendingProcessResult();
		sandbox.execImpl = () => pending.process;
		world.existing.set(SANDBOX_ID, sandbox);
		const command = 'python -c "print([1 + 2])"';

		const process = await makeCompute(world)
			.create(SANDBOX_ID)
			.startProcess(command, { processId: 'kernel' });
		await process.kill('SIGKILL');

		expect(process).toMatchObject({ id: 'kernel', command });
		expect(sandbox.execCalls[0].command[2]).toContain(`exec sh -lc '`);
		expect(sandbox.execCalls[0].command[2]).toContain(command);
		const killCommand = sandbox.execCalls[1].command[2];
		expect(killCommand).toContain('read -r pid started');
		expect(killCommand).toContain('cat "/proc/$pid/stat"');
		expect(killCommand).toContain('[ "${20}" = "$started" ]');
		expect(killCommand).toContain('kill -KILL -- "$pid"');
		expect(killCommand).not.toContain('pkill');
		expect(killCommand).not.toContain(command);
	});

	it('removes process tracking state on exit and ignores later kill requests', async () => {
		const world = makeWorld();
		const sandbox = new FakeSandbox();
		const pending = pendingProcessResult();
		let execCount = 0;
		sandbox.execImpl = () => (execCount++ === 0 ? pending.process : processResult());
		world.existing.set(SANDBOX_ID, sandbox);

		const process = await makeCompute(world).create(SANDBOX_ID).startProcess('true');
		pending.resolve(0);

		await expect.poll(() => sandbox.execCalls.length).toBe(2);
		expect(sandbox.execCalls[1].command[2]).toMatch(
			/^rm -f '\/tmp\/marimohub-process-[\w-]+\.pid'$/,
		);

		await process.kill('SIGKILL');
		expect(sandbox.execCalls).toHaveLength(2);
	});

	it('treats destroy of an absent sandbox as idempotent', async () => {
		const world = makeWorld();
		await expect(makeCompute(world).create(SANDBOX_ID).destroy()).resolves.toBeUndefined();
		expect(world.created).toHaveLength(0);
	});

	it('lists only owned sandboxes and maps their stable tags back to SandboxIds', async () => {
		const world = makeWorld();
		world.listed.push(
			new FakeSandbox({
				'marimohub.owner': 'hub-app',
				'marimohub.sandbox-id': 'sb-aaaaaaaaaaaaaaaa',
			}),
			new FakeSandbox({
				'marimohub.owner': 'hub-app',
				'marimohub.sandbox-id': 'foreign-sandbox',
			}),
			new FakeSandbox({ 'marimohub.owner': 'hub-app' }),
		);

		expect(await makeCompute(world).listActive()).toEqual([{ id: 'sb-aaaaaaaaaaaaaaaa' }]);
	});

	it('uses an image override for one sandbox', async () => {
		const world = makeWorld();
		await makeCompute(world)
			.create(SANDBOX_ID, { reuse: false, image: 'override-image' })
			.exec('true');
		expect(world.imageCalls).toEqual(['override-image']);
	});

	it('keeps unsupported mount behavior and proxy behavior unchanged', async () => {
		const world = makeWorld();
		const compute = makeCompute(world);
		await expect(
			compute.create(SANDBOX_ID).mountBucket({
				bucketName: 'b',
				endpoint: 'e',
				mountPath: '/m',
				prefix: 'p',
			}),
		).rejects.toThrow(/file copy fallback/);
		expect(await compute.proxy(new Request('https://example.com'))).toBeNull();
	});
});

function contractWorld() {
	const world = makeWorld();
	const create = world.client.sandboxes.create.bind(world.client.sandboxes);
	world.client.sandboxes.create = async (app, image, options) => {
		const sandbox = (await create(app, image, options)) as FakeSandbox;
		sandbox.execImpl = (command) => {
			return command[2]?.includes('mh-contract-fail')
				? processResult(1, '', 'scripted failure')
				: processResult();
		};
		return sandbox;
	};
	return world;
}

computeContract('ModalCompute', () => makeCompute(contractWorld()), {
	mountFallsBack: true,
	semantics: {
		failingCommand: 'mh-contract-fail',
		// Modal maps every filesystem read exception to READ_FAILED.
		absentFile: { path: '/workspace/contract-absent.txt', code: 'READ_FAILED' },
		hiddenFiles: {
			dir: '/workspace',
			seed: (inst) =>
				inst.writeFiles([
					{ path: `/workspace/${CONTRACT_VISIBLE_FILE}`, content: 'v' },
					{ path: `/workspace/${CONTRACT_HIDDEN_FILE}`, content: 'h' },
				]),
		},
	},
});
