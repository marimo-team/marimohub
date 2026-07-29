import { describe, expect, it } from 'vitest';
import type { SandboxId } from '@marimo-hub/core';
import type { SandboxProvider } from '@marimo-hub/core/ports';
import { containerResourceArgs } from './index';
import type { ContainerConfig, ContainerRunner, ContainerRunResult } from './index';

const SANDBOX_ID = 'sb-aaaaaaaaaaaaaaaa' as SandboxId;
const CONTAINER_NAME = 'marimohub-sbx-sb-aaaaaaaaaaaaaaaa';

export interface ContainerCliCall {
	args: string[];
	stdin?: string | Uint8Array;
}

export function createRecordingContainerRunner(
	handler: (args: string[], stdin?: string | Uint8Array) => ContainerRunResult | undefined,
): { runner: ContainerRunner; calls: ContainerCliCall[] } {
	const calls: ContainerCliCall[] = [];
	return {
		calls,
		runner: {
			async run(args, options) {
				calls.push({ args, stdin: options?.stdin });
				return handler(args, options?.stdin) ?? { stdout: '', stderr: '', exitCode: 0 };
			},
		},
	};
}

export function defaultContainerCliHandler(args: string[]): ContainerRunResult | undefined {
	if (args[0] === 'inspect') return { stdout: '', stderr: 'not found', exitCode: 1 };
	if (args[0] === 'port') return { stdout: '127.0.0.1:49153\n', stderr: '', exitCode: 0 };
	return undefined;
}

export function containerCliContract(
	name: string,
	engine: string,
	makeProvider: (config: ContainerConfig, runner: ContainerRunner) => SandboxProvider,
	spawnRunner: (bin?: string) => ContainerRunner,
): void {
	describe(`Container CLI contract: ${name}`, () => {
		it('creates a labelled container with a random loopback port and optional network', async () => {
			const { runner, calls } = createRecordingContainerRunner(defaultContainerCliHandler);
			const provider = makeProvider(
				{
					image: 'sandbox-image',
					bindHost: '127.0.0.1',
					network: 'sandbox-network',
				},
				runner,
			);

			await provider.create(SANDBOX_ID).exec('true');

			expect(calls.find((call) => call.args[0] === 'run')?.args).toEqual([
				'run',
				'-d',
				'--name',
				CONTAINER_NAME,
				'--label',
				'marimohub.sandbox=sb-aaaaaaaaaaaaaaaa',
				'-p',
				'127.0.0.1::2718',
				'--network',
				'sandbox-network',
				'sandbox-image',
				'sleep',
				'infinity',
			]);
		});

		it('passes a per-sandbox image override to the engine', async () => {
			const { runner, calls } = createRecordingContainerRunner(defaultContainerCliHandler);
			const provider = makeProvider({ image: 'default-image' }, runner);

			await provider.create(SANDBOX_ID, { image: 'override-image' }).exec('true');

			const run = calls.find((call) => call.args[0] === 'run')?.args ?? [];
			expect(run).toContain('override-image');
			expect(run).not.toContain('default-image');
		});

		it('maps per-sandbox resources to engine limits without changing empty options', async () => {
			expect(containerResourceArgs({})).toEqual([]);
			expect(containerResourceArgs({ cpu: 0.5, memoryBytes: 512 * 1024 ** 2 })).toEqual([
				'--cpus',
				'0.5',
				'--memory',
				'536870912',
			]);

			const { runner, calls } = createRecordingContainerRunner(defaultContainerCliHandler);
			await makeProvider({ image: 'sandbox-image' }, runner)
				.create(SANDBOX_ID, {
					resources: { cpu: 0.5, memoryBytes: 512 * 1024 ** 2 },
				})
				.exec('true');

			const run = calls.find((call) => call.args[0] === 'run')?.args ?? [];
			expect(run.slice(run.indexOf('--cpus'), run.indexOf('--cpus') + 4)).toEqual([
				'--cpus',
				'0.5',
				'--memory',
				'536870912',
			]);
		});

		it('streams file bytes over stdin', async () => {
			const { runner, calls } = createRecordingContainerRunner(defaultContainerCliHandler);
			const bytes = new Uint8Array([0xff, 0x00, 0x80]);

			await makeProvider({}, runner)
				.create(SANDBOX_ID)
				.writeFiles([{ path: '/workspace/data.bin', content: bytes }]);

			const write = calls.find((call) => call.args.includes('-i'));
			expect(write?.args).toEqual([
				'exec',
				'-i',
				CONTAINER_NAME,
				'sh',
				'-c',
				"cat > '/workspace/data.bin'",
			]);
			expect(write?.stdin).toBe(bytes);
		});

		it('resolves the published kernel port', async () => {
			const { runner, calls } = createRecordingContainerRunner(defaultContainerCliHandler);
			const sandbox = makeProvider({ host: 'kernel.example.test' }, runner).create(SANDBOX_ID);

			await expect(sandbox.exposePort(2718, { hostname: 'ignored' })).resolves.toEqual({
				url: 'http://kernel.example.test:49153',
			});
			expect(calls.find((call) => call.args[0] === 'port')?.args).toEqual([
				'port',
				CONTAINER_NAME,
				'2718/tcp',
			]);
		});

		it('lists only valid labelled sandbox container names', async () => {
			const { runner, calls } = createRecordingContainerRunner((args) => {
				if (args[0] === 'ps') {
					return {
						stdout: `${CONTAINER_NAME}\nmarimohub-sbx-invalid\nother\n`,
						stderr: '',
						exitCode: 0,
					};
				}
				return defaultContainerCliHandler(args);
			});

			await expect(makeProvider({}, runner).listActive?.()).resolves.toEqual([{ id: SANDBOX_ID }]);
			expect(calls.find((call) => call.args[0] === 'ps')?.args).toEqual([
				'ps',
				'--filter',
				'label=marimohub.sandbox',
				'--format',
				'{{.Names}}',
			]);
		});

		it('removes the container idempotently', async () => {
			let removals = 0;
			const { runner, calls } = createRecordingContainerRunner((args) => {
				if (args[0] === 'rm') {
					removals++;
					return {
						stdout: '',
						stderr: removals > 1 ? 'not found' : '',
						exitCode: removals > 1 ? 1 : 0,
					};
				}
				return defaultContainerCliHandler(args);
			});
			const sandbox = makeProvider({}, runner).create(SANDBOX_ID);

			await sandbox.destroy();
			await expect(sandbox.destroy()).resolves.toBeUndefined();
			expect(calls.filter((call) => call.args[0] === 'rm').map((call) => call.args)).toEqual([
				['rm', '-f', '-v', CONTAINER_NAME],
				['rm', '-f', '-v', CONTAINER_NAME],
			]);
		});

		it('uses the engine name in process ids and failures', async () => {
			const success = createRecordingContainerRunner(defaultContainerCliHandler);
			const process = await makeProvider({}, success.runner)
				.create(SANDBOX_ID)
				.startProcess('uv run marimo edit');
			expect(process.id).toMatch(new RegExp(`^${engine}-proc-\\d+$`));

			const failure = createRecordingContainerRunner((args) =>
				args[0] === 'run'
					? { stdout: '', stderr: 'engine unavailable', exitCode: 125 }
					: defaultContainerCliHandler(args),
			);
			await expect(
				makeProvider({}, failure.runner).create(SANDBOX_ID).exec('true'),
			).rejects.toThrow(new RegExp(`${engine} run failed.*engine unavailable`));
		});

		it('maps a missing engine binary to exit code 127', async () => {
			const result = await spawnRunner(`marimohub-no-such-${engine}-binary-xyz`).run(['ps']);
			expect(result.exitCode).toBe(127);
			expect(result.stderr).toBeTruthy();
		});
	});
}
