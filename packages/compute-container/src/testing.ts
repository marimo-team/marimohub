import { describe, expect, it } from 'vitest';
import type { SandboxId } from '@marimo-hub/core/ids';
import type { SandboxProvider } from '@marimo-hub/core/ports/sandbox';
import { scriptContractLaunch } from '@marimo-hub/core/testing/compute-contract';
import type { ContractLaunchScript } from '@marimo-hub/core/testing/compute-contract';
import { containerResourceArgs } from './index';
import { KILL_PROCESS } from './process';
import type { ContainerConfig, ContainerRunner, ContainerRunResult } from './index';

const SANDBOX_ID = 'sb-aaaaaaaaaaaaaaaa' as SandboxId;
const CONTAINER_NAME = 'marimohub-sbx-sb-aaaaaaaaaaaaaaaa';

export interface ContainerCliCall {
	args: string[];
	stdin?: string | Uint8Array;
	timeout?: number;
}

export function createRecordingContainerRunner(
	handler: (args: string[], stdin?: string | Uint8Array) => ContainerRunResult | undefined,
): { runner: ContainerRunner; calls: ContainerCliCall[] } {
	const calls: ContainerCliCall[] = [];
	return {
		calls,
		runner: {
			async run(args, options) {
				calls.push({ args, stdin: options?.stdin, timeout: options?.timeout });
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

/**
 * Stateful CLI handler for the compute contract's `launchProcess` cases. The
 * adapter starts the supervisor detached, then polls its log file with an
 * in-container waiter (identified by its `terminal_events` script); the handler
 * remembers the scripted transcript of the last contract launch and serves it
 * from the waiter.
 */
export function contractLaunchCliHandler(): (args: string[]) => ContainerRunResult | undefined {
	let launch: ContractLaunchScript | undefined;
	return (args) => {
		const cmd = args.at(-1) ?? '';
		if (cmd.includes('terminal_events')) {
			return { stdout: launch?.transcript ?? '', stderr: '', exitCode: 0 };
		}
		const scripted = scriptContractLaunch(cmd);
		if (scripted) {
			launch = scripted;
			return { stdout: '', stderr: '', exitCode: 0 };
		}
		return;
	};
}

export function containerCliContract(
	name: string,
	engine: string,
	makeProvider: (config: ContainerConfig, runner: ContainerRunner) => SandboxProvider,
	spawnRunner: (bin?: string) => ContainerRunner,
): void {
	describe(`Container CLI contract: ${name}`, () => {
		it.each(['missing', 'stopped', 'unavailable'])(
			'strict attachment never creates or replaces a %s container',
			async (state) => {
				const { runner, calls } = createRecordingContainerRunner((args) => {
					if (args[0] === 'inspect')
						return {
							stdout: state === 'stopped' ? 'false' : '',
							stderr: state === 'unavailable' ? 'daemon unavailable' : 'not found',
							exitCode: state === 'stopped' ? 0 : 1,
						};
				});
				const sandbox = makeProvider({}, runner).connectExisting!(SANDBOX_ID);
				await expect(sandbox.exec('true')).rejects.toThrow('not running');
				expect(calls.map((call) => call.args[0])).toEqual(['inspect']);
				await sandbox.destroy();
				await sandbox.destroy();
				expect(calls.map((call) => call.args[0])).toEqual(['inspect', 'rm', 'rm']);
			},
		);

		it('strict attachment reconnects and refuses to restart a container that later stops', async () => {
			let running = true;
			const { runner, calls } = createRecordingContainerRunner((args) => {
				if (args[0] === 'inspect') return { stdout: String(running), stderr: '', exitCode: 0 };
			});
			const sandbox = makeProvider({}, runner).connectExisting!(SANDBOX_ID);
			expect((await sandbox.exec('true')).success).toBe(true);
			running = false;
			await expect(sandbox.exec('true')).rejects.toThrow('not running');
			expect(calls.some((call) => call.args[0] === 'run' || call.args[0] === 'rm')).toBe(false);
		});

		it.each(['', 'not-a-port', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:1.5'])(
			'rejects malformed published ports and retries after output %j',
			async (stdout) => {
				let output = stdout;
				const { runner, calls } = createRecordingContainerRunner((args) =>
					args[0] === 'port'
						? { stdout: output, stderr: '', exitCode: 0 }
						: defaultContainerCliHandler(args),
				);
				const sandbox = makeProvider({ surfacePorts: [4096] }, runner).create(SANDBOX_ID);
				await expect(sandbox.exposePort(4096, { hostname: 'ignored' })).rejects.toThrow(
					'could not parse host port',
				);
				output = '127.0.0.1:49155';
				await expect(sandbox.exposePort(4096, { hostname: 'ignored' })).resolves.toEqual({
					url: 'http://localhost:49155',
				});
				expect(calls.filter((call) => call.args[0] === 'port')).toHaveLength(2);
			},
		);

		it.each([
			['127.0.0.1:1\n', 1],
			['[::]:65535\n', 65535],
			['0.0.0.0:49155\n[::]:49155\n', 49155],
		])('accepts published port output %j', async (stdout, hostPort) => {
			const { runner } = createRecordingContainerRunner((args) =>
				args[0] === 'port' ? { stdout, stderr: '', exitCode: 0 } : defaultContainerCliHandler(args),
			);
			const sandbox = makeProvider({ host: 'sandbox.test', surfacePorts: [4096] }, runner).create(
				SANDBOX_ID,
			);
			await expect(sandbox.exposePort(4096, { hostname: 'ignored' })).resolves.toEqual({
				url: `http://sandbox.test:${hostPort}`,
			});
		});

		it('rejects unreserved ports without consulting the engine', async () => {
			const { runner, calls } = createRecordingContainerRunner(defaultContainerCliHandler);
			const sandbox = makeProvider({ surfacePorts: [4096] }, runner).create(SANDBOX_ID);
			await expect(sandbox.exposePort(8443, { hostname: 'ignored' })).rejects.toThrow(
				'port 8443 was not reserved at creation',
			);
			expect(calls).toEqual([]);
		});

		it('copies configured ports so caller mutations cannot change reservations', async () => {
			const surfacePorts = [1, 65535];
			const { runner, calls } = createRecordingContainerRunner(defaultContainerCliHandler);
			const sandbox = makeProvider({ surfacePorts }, runner).create(SANDBOX_ID);
			surfacePorts.push(4096);
			await sandbox.exec('true');
			const run = calls.find((call) => call.args[0] === 'run')!.args;
			expect(run.filter((_, i) => run[i - 1] === '-p')).toEqual([
				'127.0.0.1::2718',
				'127.0.0.1::1',
				'127.0.0.1::65535',
			]);
			await expect(sandbox.exposePort(4096, { hostname: 'ignored' })).rejects.toThrow(
				'was not reserved',
			);
		});

		it('retries a rejected engine call without poisoning the port cache', async () => {
			let unavailable = true;
			const { runner } = createRecordingContainerRunner((args) => {
				if (args[0] === 'port' && unavailable) throw new Error('engine disconnected');
				return defaultContainerCliHandler(args);
			});
			const sandbox = makeProvider({ surfacePorts: [4096] }, runner).create(SANDBOX_ID);
			await expect(sandbox.exposePort(4096, { hostname: 'ignored' })).rejects.toThrow(
				'engine disconnected',
			);
			unavailable = false;
			await expect(sandbox.exposePort(4096, { hostname: 'ignored' })).resolves.toEqual({
				url: 'http://localhost:49153',
			});
		});

		it('keeps separate process records and forwards the requested kill signal', async () => {
			const { runner, calls } = createRecordingContainerRunner(defaultContainerCliHandler);
			const provider = makeProvider({}, runner);
			const kernel = await provider.create(SANDBOX_ID).startProcess('run-kernel');
			const surface = await provider.create(SANDBOX_ID).startProcess('run-surface');
			await surface.kill('SIGKILL');
			await kernel.kill();
			const launches = calls.filter((call) => call.args.at(-1)?.includes('subprocess.DEVNULL'));
			const records = launches.map(
				(call) => call.args.at(-1)!.match(/\/tmp\/marimohub-proc-[\w-]+\.pid/)![0],
			);
			expect(new Set(records).size).toBe(2);
			const kills = calls.filter((call) => call.args.includes(KILL_PROCESS));
			expect(kills.map((call) => call.args.slice(-2))).toEqual([
				[records[1], 'SIGKILL'],
				[records[0], 'SIGTERM'],
			]);
		});

		it('reports process cleanup failures', async () => {
			const { runner } = createRecordingContainerRunner((args) => {
				if (args.includes(KILL_PROCESS)) {
					return { stdout: '', stderr: 'permission denied', exitCode: 1 };
				}
				return defaultContainerCliHandler(args);
			});
			const process = await makeProvider({}, runner).create(SANDBOX_ID).startProcess('run-surface');
			await expect(process.kill()).rejects.toThrow(
				'Could not stop sandbox process: permission denied',
			);
		});

		it('publishes each surface once and resolves distinct host ports across reconnects', async () => {
			const published = new Map([
				['2718/tcp', 49153],
				['8443/tcp', 49154],
				['4096/tcp', 49155],
			]);
			const { runner, calls } = createRecordingContainerRunner((args) => {
				if (args[0] === 'port') {
					return { stdout: `127.0.0.1:${published.get(args[2])}\n`, stderr: '', exitCode: 0 };
				}
				return defaultContainerCliHandler(args);
			});
			const config = { host: 'sandbox.test', surfacePorts: [8443, 4096, 8443, 2718] };
			const provider = makeProvider(config, runner);
			const sandbox = provider.create(SANDBOX_ID);
			expect(provider.capabilities?.multiPort).toBe(true);
			await sandbox.exec('true');
			const run = calls.find((call) => call.args[0] === 'run')!.args;
			expect(run.filter((_, i) => run[i - 1] === '-p')).toEqual([
				'127.0.0.1::2718',
				'127.0.0.1::8443',
				'127.0.0.1::4096',
			]);
			for (const instance of [sandbox, makeProvider(config, runner).create(SANDBOX_ID)]) {
				for (const [port, hostPort] of published) {
					for (let attempt = 0; attempt < 2; attempt++) {
						await expect(
							instance.exposePort(Number.parseInt(port, 10), { hostname: 'ignored' }),
						).resolves.toEqual({
							url: `http://sandbox.test:${hostPort}`,
						});
					}
				}
			}
			expect(calls.filter((call) => call.args[0] === 'port')).toHaveLength(6);
		});

		it('keeps multiPort disabled without secondary port reservations', () => {
			const { runner } = createRecordingContainerRunner(defaultContainerCliHandler);
			for (const surfacePorts of [undefined, [], [2718]]) {
				expect(makeProvider({ surfacePorts }, runner).capabilities?.multiPort).toBe(false);
			}
		});

		it.each([0, -1, 65_536, 4096.5, Number.NaN, Infinity])(
			'rejects invalid surface port %s',
			(port) => {
				const { runner } = createRecordingContainerRunner(defaultContainerCliHandler);
				expect(() => makeProvider({ surfacePorts: [port] }, runner)).toThrow(
					`Invalid ${engine} surface port`,
				);
			},
		);

		it('fails when an existing container has no published mapping for a surface', async () => {
			let published = false;
			const { runner } = createRecordingContainerRunner((args) => {
				if (args[0] === 'port') {
					return published
						? { stdout: '[::]:49155\n', stderr: '', exitCode: 0 }
						: { stdout: '', stderr: 'no public port 4096/tcp published', exitCode: 1 };
				}
				return defaultContainerCliHandler(args);
			});
			const sandbox = makeProvider({ surfacePorts: [4096] }, runner).create(SANDBOX_ID);
			await expect(sandbox.exposePort(4096, { hostname: 'ignored' })).rejects.toThrow(
				'no public port 4096/tcp',
			);
			published = true;
			await expect(sandbox.exposePort(4096, { hostname: 'ignored' })).resolves.toEqual({
				url: 'http://localhost:49155',
			});
		});

		it.each(['destroyed', 'missing', 'stopped'] as const)(
			'resolves new host ports after the container is %s',
			async (change) => {
				let state = 'missing';
				let generation = 0;
				const { runner } = createRecordingContainerRunner((args) => {
					if (args[0] === 'inspect') {
						return {
							stdout: String(state === 'running'),
							stderr: '',
							exitCode: state === 'missing' ? 1 : 0,
						};
					}
					if (args[0] === 'run') {
						state = 'running';
						generation++;
					}
					if (args[0] === 'rm') state = 'missing';
					if (args[0] === 'port') {
						const hostPort = 49000 + generation * 10 + (args[2] === '2718/tcp' ? 0 : 1);
						return { stdout: `127.0.0.1:${hostPort}\n`, stderr: '', exitCode: 0 };
					}
					return;
				});
				const sandbox = makeProvider({ surfacePorts: [4096] }, runner).create(SANDBOX_ID);
				await sandbox.exec('true');
				await expect(sandbox.exposePort(2718, { hostname: 'ignored' })).resolves.toEqual({
					url: 'http://localhost:49010',
				});
				await expect(sandbox.exposePort(4096, { hostname: 'ignored' })).resolves.toEqual({
					url: 'http://localhost:49011',
				});
				if (change === 'destroyed') await sandbox.destroy();
				else state = change;
				await sandbox.exec('true');
				await expect(sandbox.exposePort(2718, { hostname: 'ignored' })).resolves.toEqual({
					url: 'http://localhost:49020',
				});
				await expect(sandbox.exposePort(4096, { hostname: 'ignored' })).resolves.toEqual({
					url: 'http://localhost:49021',
				});
			},
		);

		it.each(['destroyed', 'missing', 'stopped'] as const)(
			'restores the environment after the container is %s without rewriting it while running',
			async (change) => {
				let state: 'missing' | 'stopped' | 'running' = 'missing';
				const files = new Map<string, string | Uint8Array>();
				const { runner, calls } = createRecordingContainerRunner((args, stdin) => {
					if (args[0] === 'inspect') {
						return {
							stdout: String(state === 'running'),
							stderr: '',
							exitCode: state === 'missing' ? 1 : 0,
						};
					}
					if (args[0] === 'run' || args[0] === 'rm') {
						state = args[0] === 'run' ? 'running' : 'missing';
						files.clear();
					}
					if (args[0] === 'exec') {
						const command = args.at(-1)!;
						const destination = command.match(/cat > '([^']+)'/)?.[1];
						if (destination && stdin !== undefined) files.set(destination, stdin);
						const source = command.match(/^\. '([^']+)'/)?.[1];
						if (source && !files.has(source)) {
							return { stdout: '', stderr: 'environment file missing', exitCode: 2 };
						}
					}
					return;
				});
				const sandbox = makeProvider({}, runner).create(SANDBOX_ID);
				await sandbox.setEnvVars({ TOKEN: 'secret' });
				await sandbox.setEnvVars({ CACHE: '/tmp/cache' }, { onlyIfUnset: true });
				await sandbox.exec('first');
				await sandbox.exec('second');
				const writes = () => calls.filter((call) => call.stdin !== undefined);
				expect(writes()).toHaveLength(1);
				const originalPath = [...files.keys()][0];

				if (change === 'destroyed') await sandbox.destroy();
				else state = change;
				if (change === 'missing') files.clear();
				expect((await sandbox.exec('after-recreation')).success).toBe(true);
				await sandbox.exec('still-running');

				expect(calls.filter((call) => call.args[0] === 'run')).toHaveLength(2);
				expect(writes().map((call) => call.stdin)).toEqual([
					"export TOKEN='secret'; [ -n \"${CACHE+x}\" ] || export CACHE='/tmp/cache'; ",
					"export TOKEN='secret'; [ -n \"${CACHE+x}\" ] || export CACHE='/tmp/cache'; ",
				]);
				expect(files.size).toBe(1);
				expect(files.has(originalPath)).toBe(false);
			},
		);

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
				'--init',
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

		it.each([
			[undefined, [], []],
			['', [], []],
			[
				'hub-prod_1.a',
				['--label', 'marimohub.owner=hub-prod_1.a'],
				['--filter', 'label=marimohub.owner=hub-prod_1.a'],
			],
		])(
			'labels and lists only valid sandbox containers with owner tag %j',
			async (ownerTag, ownerLabel, ownerFilter) => {
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
				const provider = makeProvider({ image: 'sandbox-image', ownerTag }, runner);

				await provider.create(SANDBOX_ID).exec('true');
				await expect(provider.listActive?.()).resolves.toEqual([{ id: SANDBOX_ID }]);
				expect(calls.find((call) => call.args[0] === 'run')?.args).toEqual([
					'run',
					'-d',
					'--init',
					'--name',
					CONTAINER_NAME,
					'--label',
					`marimohub.sandbox=${SANDBOX_ID}`,
					...ownerLabel,
					'-p',
					'127.0.0.1::2718',
					'sandbox-image',
					'sleep',
					'infinity',
				]);
				expect(calls.find((call) => call.args[0] === 'ps')?.args).toEqual([
					'ps',
					'--filter',
					'label=marimohub.sandbox',
					...ownerFilter,
					'--format',
					'{{.Names}}',
				]);
			},
		);

		it('scopes discovery to the owner tag on a shared engine', async () => {
			const containers = new Map<string, string[]>();
			const { runner } = createRecordingContainerRunner((args) => {
				if (args[0] === 'run') {
					containers.set(
						args[args.indexOf('--name') + 1],
						args.filter((_, i) => args[i - 1] === '--label'),
					);
				}
				if (args[0] === 'ps') {
					const filters = args
						.filter((_, i) => args[i - 1] === '--filter')
						.map((filter) => filter.slice('label='.length));
					return {
						stdout: [...containers]
							.filter(([, labels]) =>
								filters.every((filter) =>
									labels.some((label) => label === filter || label.startsWith(`${filter}=`)),
								),
							)
							.map(([name]) => name)
							.join('\n'),
						stderr: '',
						exitCode: 0,
					};
				}
				return defaultContainerCliHandler(args);
			});
			const otherId = 'sb-bbbbbbbbbbbbbbbb' as SandboxId;
			await makeProvider({ ownerTag: 'hub-a' }, runner).create(SANDBOX_ID).exec('true');
			await makeProvider({ ownerTag: 'hub-b' }, runner).create(otherId).exec('true');

			await expect(makeProvider({ ownerTag: 'hub-a' }, runner).listActive?.()).resolves.toEqual([
				{ id: SANDBOX_ID },
			]);
			await expect(makeProvider({ ownerTag: 'hub-b' }, runner).listActive?.()).resolves.toEqual([
				{ id: otherId },
			]);
			await expect(makeProvider({ ownerTag: 'hub-c' }, runner).listActive?.()).resolves.toEqual([]);
			// An untagged hub on a shared engine still sees every owner's sandboxes.
			await expect(makeProvider({}, runner).listActive?.()).resolves.toEqual([
				{ id: SANDBOX_ID },
				{ id: otherId },
			]);
		});

		it('removes the container idempotently', async () => {
			let removals = 0;
			const { runner, calls } = createRecordingContainerRunner((args) => {
				if (args[0] === 'rm') {
					removals++;
					return {
						stdout: '',
						stderr: removals > 1 ? 'no such container' : '',
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

		it('does not report successful deletion when the engine is unavailable', async () => {
			const { runner, calls } = createRecordingContainerRunner(() => ({
				stdout: '',
				stderr: 'daemon unavailable',
				exitCode: 1,
			}));
			await expect(makeProvider({}, runner).create(SANDBOX_ID).destroy()).rejects.toThrow(
				'daemon unavailable',
			);
			expect(calls.map((call) => call.args[0])).toEqual(['rm']);
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

		it('bounds both the engine client and the in-container command', async () => {
			const { runner, calls } = createRecordingContainerRunner(defaultContainerCliHandler);

			await makeProvider({}, runner).create(SANDBOX_ID).exec('uv sync', { timeout: 250 });

			const call = calls.find((candidate) => candidate.args[0] === 'exec');
			expect(call).toEqual({
				args: [
					'exec',
					CONTAINER_NAME,
					'python3',
					'-c',
					expect.stringContaining('os.killpg(process.pid, signal.SIGKILL)'),
					'225',
					'uv sync',
				],
				stdin: undefined,
				timeout: 250,
			});
		});

		it('kills a stalled engine client when its timeout expires', async () => {
			const result = await spawnRunner('sh').run(['-c', 'exec sleep 10'], { timeout: 20 });

			expect(result).toMatchObject({
				exitCode: 124,
				stderr: expect.stringContaining('command timed out after 20ms'),
			});
		});
	});
}
