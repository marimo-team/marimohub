import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Millis } from '@marimo-hub/core';
import type { SandboxId } from '@marimo-hub/core';
import { listFilesFailure } from '@marimo-hub/core/ports';
import { computeContract } from '@marimo-hub/core/testing/compute-contract';
import {
	expectExecResult,
	expectFileResult,
	expectListFilesResult,
} from '@marimo-hub/core/testing';
import {
	KubernetesCompute,
	kubernetesProfileResources,
	parseImagePullMs,
	resourceName,
} from './index';
import type {
	EnsureSandboxOptions,
	K8sClient,
	K8sExecResult,
	K8sPodPhaseInfo,
	KubernetesConfig,
} from './index';

/**
 * Tests for the native Kubernetes compute adapter.
 *
 * Hermetic: an in-memory fake `K8sClient` is injected via the constructor (no
 * cluster, no kubeconfig), the analogue of the CoreWeave adapter's fake SDK
 * client. The fake keeps a registry of Pods keyed by their resource name so
 * reconnect / list / delete behave realistically, and an `execImpl` hook lets a
 * test script the in-pod command results (PID echo, port probe, file reads).
 */

const SANDBOX_ID = 'sb-abc' as SandboxId;
const NAME = 'mh-sb-abc';

const baseConfig: KubernetesConfig = {
	image: 'my-image',
	hostname: 'hub.example.com',
	podReadyTimeout: Millis.seconds(2),
};

type ExecImpl = (command: string[], stdin?: string | Uint8Array) => K8sExecResult | undefined;

/** Swallow the adapter's structured `k8s_ensure` log lines; tests read the spy. */
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	warnSpy.mockRestore();
});

function makeWorld(opts?: {
	execImpl?: ExecImpl;
	phase?: string;
	schedulingFailure?: string;
	bootInfo?: Omit<K8sPodPhaseInfo, 'phase'>;
	imagePullMessage?: string;
}) {
	const ensured: EnsureSandboxOptions[] = [];
	const deleted: string[] = [];
	const execCalls: { name: string; command: string[]; stdin?: string | Uint8Array }[] = [];
	const pods = new Map<string, { sandboxId: SandboxId; phase: string }>();

	const client: K8sClient = {
		ensure: async (o) => {
			ensured.push(o);
			const createdPod = !pods.has(o.name);
			if (createdPod) pods.set(o.name, { sandboxId: o.sandboxId, phase: opts?.phase ?? 'Running' });
			return { createdPod };
		},
		getPhase: async (name) => {
			const p = pods.get(name);
			return p ? { phase: p.phase, ...opts?.bootInfo } : undefined;
		},
		getSchedulingFailure: async () => opts?.schedulingFailure,
		getImagePullMessage: async () => opts?.imagePullMessage,
		exec: async (name, command, stdin) => {
			execCalls.push({ name, command, stdin });
			return opts?.execImpl?.(command, stdin) ?? { stdout: '', stderr: '', exitCode: 0 };
		},
		delete: async (name) => {
			deleted.push(name);
			pods.delete(name);
		},
		list: async () =>
			[...pods.values()].map((p) => ({
				sandboxId: p.sandboxId,
				phase: p.phase,
				createdAt: '2020-01-01T00:00:00.000Z',
			})),
	};

	const setPhase = (name: string, phase: string) => {
		const p = pods.get(name);
		if (p) p.phase = phase;
	};

	return { client, ensured, deleted, execCalls, pods, setPhase };
}

function makeCompute(world: ReturnType<typeof makeWorld>, config: KubernetesConfig = baseConfig) {
	return new KubernetesCompute(config, world.client);
}

/** The actual command string the adapter wraps in `['sh','-c', …]`. */
const shCmd = (call: { command: string[] }) => call.command[2];

describe('parseImagePullMs', () => {
	it('parses the kubelet Pulled message Go durations', () => {
		expect(
			parseImagePullMs('Successfully pulled image "x" in 588ms (588ms including waiting)'),
		).toBe(588);
		expect(parseImagePullMs('Successfully pulled image "x" in 2.096s (…)')).toBe(2096);
		expect(parseImagePullMs('Successfully pulled image "x" in 1m2.5s (…)')).toBe(62_500);
	});

	it('maps a cached image to 0 and unknown wording to undefined', () => {
		expect(parseImagePullMs('Container image "x" already present on machine')).toBe(0);
		expect(parseImagePullMs(undefined)).toBeUndefined();
		expect(parseImagePullMs('some future kubelet wording')).toBeUndefined();
	});
});

describe('resourceName', () => {
	it('derives a DNS-1123-safe name prefixed with mh-', () => {
		expect(resourceName('sb-abc' as SandboxId)).toBe('mh-sb-abc');
		expect(resourceName('SB_ABC.123' as SandboxId)).toBe('mh-sb-abc-123');
	});
});

describe('KubernetesCompute', () => {
	describe('exec()', () => {
		it('runs user commands in a login shell (profile-provided PATH keeps working)', async () => {
			const world = makeWorld();
			const result = await makeCompute(world).create(SANDBOX_ID).exec('echo hi');
			expectExecResult(result, { success: true, stdout: '', stderr: '' });
			expect(world.execCalls.at(-1)).toMatchObject({
				name: NAME,
				command: ['sh', '-lc', 'echo hi'],
			});
		});

		it('reports success=false on a non-zero exit', async () => {
			const world = makeWorld({
				execImpl: () => ({ stdout: '', stderr: 'boom', exitCode: 1 }),
			});
			const result = await makeCompute(world).create(SANDBOX_ID).exec('bad');
			expectExecResult(result, { success: false, stderr: 'boom' });
		});
	});

	describe('lazy ensure()', () => {
		it('materialises the Pod with our name, image, port, and ingress host', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID).exec('true');
			expect(world.ensured).toHaveLength(1);
			const o = world.ensured[0];
			expect(o).toMatchObject({
				name: NAME,
				sandboxId: SANDBOX_ID,
				image: 'my-image',
				port: 2718,
				namespace: 'default',
				host: 'sb-abc.hub.example.com',
			});
		});

		it('ensures once across repeated calls on the same instance', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.exec('a');
			await inst.exec('b');
			expect(world.ensured).toHaveLength(1);
		});

		it('a re-resolved instance operates on the same Pod name', async () => {
			const world = makeWorld();
			const compute = makeCompute(world);
			await compute.create(SANDBOX_ID).exec('true');
			// A fresh instance (as the API does for teardown) targets the same Pod.
			await compute
				.create(SANDBOX_ID)
				.writeFiles([{ path: '/workspace/notebook.py', content: 'x=1' }]);
			expect(world.execCalls.every((c) => c.name === NAME)).toBe(true);
		});

		it('a per-create image override replaces the configured Pod image', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID, { image: 'override-image' }).exec('true');
			expect(world.ensured[0]).toMatchObject({ image: 'override-image' });
		});

		it('passes resources, service account, and image pull settings through', async () => {
			const world = makeWorld();
			await makeCompute(world, {
				...baseConfig,
				serviceAccountName: 'marimo-kernel',
				imagePullSecret: 'regcred',
				imagePullPolicy: 'Always',
				resources: { cpu: '2', memory: '4Gi', gpu: '1' },
			})
				.create(SANDBOX_ID)
				.exec('true');
			expect(world.ensured[0]).toMatchObject({
				serviceAccountName: 'marimo-kernel',
				imagePullSecret: 'regcred',
				imagePullPolicy: 'Always',
				resources: { cpu: '2', memory: '4Gi', gpu: '1' },
			});
		});

		it('maps profile resources to equal requests and limits', async () => {
			expect(kubernetesProfileResources({})).toBeUndefined();
			expect(kubernetesProfileResources({ cpu: 1.5, memoryBytes: 2 * 1024 ** 3 })).toEqual({
				cpu: '1500m',
				memory: '2048Mi',
				profileLimits: { cpu: true, memory: true },
			});
			expect(kubernetesProfileResources({ cpu: 1.2344 })).toEqual({
				cpu: '1235m',
				profileLimits: { cpu: true },
			});

			const world = makeWorld();
			await makeCompute(world)
				.create(SANDBOX_ID, {
					resources: { cpu: 1.5, memoryBytes: 2 * 1024 ** 3 },
				})
				.exec('true');
			expect(world.ensured[0].resources).toEqual({
				cpu: '1500m',
				memory: '2048Mi',
				profileLimits: { cpu: true, memory: true },
			});
		});

		it('limits only profile fields when overlaying legacy requests', async () => {
			const world = makeWorld();
			await makeCompute(world, {
				...baseConfig,
				resources: { cpu: '2', memory: '4Gi' },
			})
				.create(SANDBOX_ID, { resources: { memoryBytes: 1024 ** 3 } })
				.exec('true');
			expect(world.ensured[0].resources).toEqual({
				cpu: '2',
				memory: '1024Mi',
				profileLimits: { memory: true },
			});
		});

		it('throws immediately when the pod enters a terminal phase while becoming ready', async () => {
			const world = makeWorld({ phase: 'Failed' });

			await expect(makeCompute(world).create(SANDBOX_ID).exec('true')).rejects.toThrow(
				/entered terminal phase Failed/,
			);
		});

		it('times out when the Pod stays Pending (never reaches Running)', async () => {
			const world = makeWorld({ phase: 'Pending' });
			const compute = makeCompute(world, { ...baseConfig, podReadyTimeout: Millis.of(30) });
			await expect(compute.create(SANDBOX_ID).exec('true')).rejects.toThrow(
				/timed out waiting for pod .* to reach Running/,
			);
		});

		it('includes the scheduler rejection when a pending Pod times out', async () => {
			const world = makeWorld({
				phase: 'Pending',
				schedulingFailure: '0/3 nodes are available: 3 Insufficient cpu.',
			});
			const compute = makeCompute(world, { ...baseConfig, podReadyTimeout: Millis.of(30) });
			await expect(compute.create(SANDBOX_ID).exec('true')).rejects.toThrow(/Insufficient cpu/);
		});
	});

	describe('writeFile() / readFile()', () => {
		it('writeFile pipes content via stdin and mkdir -p the parent dir', async () => {
			const world = makeWorld();
			await makeCompute(world)
				.create(SANDBOX_ID)
				.writeFiles([{ path: '/workspace/notebook.py', content: 'x=1' }]);
			const call = world.execCalls.at(-1)!;
			expect(call.stdin).toBe('x=1');
			expect(shCmd(call)).toContain("mkdir -p '/workspace'");
			expect(shCmd(call)).toContain("cat > '/workspace/notebook.py'");
			// Protocol command, NOT a login shell: profile stdout would corrupt the
			// exec result, and cat/mkdir need no profile PATH.
			expect(call.command[1]).toBe('-c');
		});

		it('readFile runs its cat in a non-login shell (profile stdout would corrupt content)', async () => {
			const world = makeWorld({
				execImpl: (cmd) =>
					cmd[2].startsWith('cat -- ')
						? { stdout: 'print(1)', stderr: '', exitCode: 0 }
						: undefined,
			});
			await makeCompute(world).create(SANDBOX_ID).readFile('/workspace/notebook.py');
			const call = world.execCalls.find((c) => shCmd(c).startsWith('cat -- '))!;
			expect(call.command[1]).toBe('-c');
		});

		it('readFile returns file contents from the in-pod cat', async () => {
			const world = makeWorld({
				execImpl: (cmd) =>
					cmd[2].startsWith('cat -- ')
						? { stdout: 'print(1)', stderr: '', exitCode: 0 }
						: undefined,
			});
			const res = await makeCompute(world).create(SANDBOX_ID).readFile('/workspace/notebook.py');
			expectFileResult(res, { success: true, content: 'print(1)', encoding: 'utf-8' });
		});

		it('readFile returns success:false when cat fails', async () => {
			const world = makeWorld({
				execImpl: (cmd) =>
					cmd[2].startsWith('cat -- ') ? { stdout: '', stderr: 'missing', exitCode: 1 } : undefined,
			});
			const res = await makeCompute(world).create(SANDBOX_ID).readFile('/workspace/missing.py');

			expect(res).toEqual({
				success: false,
				content: '',
				error: { code: 'READ_FAILED' },
			});
		});

		it('writeFile streams a large file via stdin, never into the exec argv (ARG_MAX)', async () => {
			const world = makeWorld();
			const big = new Uint8Array(1024 * 1024).fill(65);
			await makeCompute(world)
				.create(SANDBOX_ID)
				.writeFiles([{ path: '/workspace/big.bin', content: big }]);
			const call = world.execCalls.at(-1)!;
			// The bytes ride stdin verbatim…
			expect(call.stdin).toBe(big);
			// …and the argv (mkdir && cat > path) never carries them.
			expect(shCmd(call).length).toBeLessThan(big.length);
		});

		it('writeFile throws when the in-pod write command fails', async () => {
			const world = makeWorld({
				execImpl: (cmd) =>
					cmd[2].includes('cat >')
						? { stdout: '', stderr: 'permission denied', exitCode: 1 }
						: undefined,
			});

			await expect(
				makeCompute(world)
					.create(SANDBOX_ID)
					.writeFiles([{ path: '/workspace/notebook.py', content: 'x=1' }]),
			).rejects.toThrow(/permission denied/);
		});
	});

	describe('listFiles()', () => {
		const findOutput = (lines: string[]) => `${lines.join('\n')}\n`;

		it('parses find output and filters hidden files', async () => {
			const world = makeWorld({
				execImpl: (cmd) =>
					cmd[2].includes('find')
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
			const res = await makeCompute(world).create(SANDBOX_ID).listFiles('/workspace');
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
			const world = makeWorld({
				execImpl: (cmd) =>
					cmd[2].includes('find')
						? { stdout: findOutput(['f\t5\t/workspace/.hidden']), stderr: '', exitCode: 0 }
						: undefined,
			});
			const res = await makeCompute(world)
				.create(SANDBOX_ID)
				.listFiles('/workspace', { recursive: true, includeHidden: true });
			expect(res.files.map((f) => f.name)).toEqual(['.hidden']);
			const find = world.execCalls.find((c) => shCmd(c).includes('find'))!;
			expect(shCmd(find)).not.toContain('-maxdepth 1');
		});

		it('returns success:false when find fails', async () => {
			const world = makeWorld({
				execImpl: (cmd) =>
					cmd[2].includes('find') ? { stdout: '', stderr: 'missing', exitCode: 1 } : undefined,
			});
			await expect(makeCompute(world).create(SANDBOX_ID).listFiles('/workspace')).resolves.toEqual(
				listFilesFailure(),
			);
		});

		it('returns success:false when ensure or exec throws', async () => {
			const world = makeWorld({ phase: 'Failed' });

			await expect(makeCompute(world).create(SANDBOX_ID).listFiles('/workspace')).resolves.toEqual(
				listFilesFailure('BACKEND_ERROR'),
			);
		});
	});

	describe('mountBucket()', () => {
		it('throws so the provisioner falls back to file copy, before ensuring anything', async () => {
			const world = makeWorld();
			await expect(
				makeCompute(world).create(SANDBOX_ID).mountBucket({
					bucketName: 'b',
					endpoint: 'e',
					mountPath: '/m',
					prefix: 'p',
				}),
			).rejects.toThrow(/file copy/);
			expect(world.ensured).toHaveLength(0);
		});
	});

	describe('startProcess().waitForPort()', () => {
		it('launches marimo detached and waits with a chunked IN-POD loop', async () => {
			let chunks = 0;
			const world = makeWorld({
				execImpl: (cmd) => {
					if (cmd[2].includes('setsid')) return { stdout: '4242', stderr: '', exitCode: 0 };
					if (cmd[2].includes('connect_ex')) {
						chunks++;
						return { stdout: '', stderr: '', exitCode: chunks >= 2 ? 0 : 1 };
					}
					// Liveness check between chunks: the kernel is still running.
					if (cmd[2].startsWith('kill -0')) return { stdout: '', stderr: '', exitCode: 0 };
					return;
				},
			});
			const inst = makeCompute(world).create(SANDBOX_ID);
			const proc = await inst.startProcess('uv run marimo edit --port 2718', { cwd: '/workspace' });
			await proc.waitForPort(2718, { timeout: 5000 });
			expect(chunks).toBe(2);

			// The probe loops in-pod on its own deadline — one exec per CHUNK, not
			// one exec per probe attempt.
			const wait = world.execCalls.find((c) => shCmd(c).includes('connect_ex'))!;
			expect(shCmd(wait)).toContain('while');

			const launch = world.execCalls.find((c) => shCmd(c).includes('setsid'))!;
			expect(shCmd(launch)).toContain("cd '/workspace'");
			expect(shCmd(launch)).toContain('uv run marimo edit --port 2718');
			// Outer shell non-login (its stdout is the parsed PID); the detached
			// inner shell is a login shell so profile env reaches the kernel.
			expect(launch.command[1]).toBe('-c');
			expect(shCmd(launch)).toContain('setsid sh -lc');
			expect(proc.id).toContain('4242');
		});

		it('honors a sub-second timeout in the chunk it hands to the pod', async () => {
			const world = makeWorld({
				execImpl: (cmd) => {
					if (cmd[2].includes('setsid')) return { stdout: '4242', stderr: '', exitCode: 0 };
					if (cmd[2].includes('connect_ex')) return { stdout: '', stderr: '', exitCode: 0 };
					return;
				},
			});
			const proc = await makeCompute(world).create(SANDBOX_ID).startProcess('run kernel');
			await proc.waitForPort(2718, { timeout: 250 });
			const wait = world.execCalls.find((c) => shCmd(c).includes('connect_ex'))!;
			expect(shCmd(wait)).toContain('time.monotonic()+0.25');
		});

		it('reports a kernel that died as exited-before-port, with its log', async () => {
			const world = makeWorld({
				execImpl: (cmd) => {
					if (cmd[2].includes('setsid')) return { stdout: '4242', stderr: '', exitCode: 0 };
					if (cmd[2].includes('connect_ex')) return { stdout: '', stderr: '', exitCode: 1 };
					if (cmd[2].startsWith('kill -0')) return { stdout: '', stderr: '', exitCode: 1 };
					if (cmd[2].includes('cat /tmp/mh-proc')) {
						return { stdout: 'Traceback: boom', stderr: '', exitCode: 0 };
					}
					return;
				},
			});
			const proc = await makeCompute(world).create(SANDBOX_ID).startProcess('run kernel');
			// The first line must match the provisioner's crash attribution
			// (`/before port \d+/`) so a crash is never reported as a timeout.
			await expect(proc.waitForPort(2718, { timeout: 5000 })).rejects.toThrow(
				/^process exited before port 2718 opened\.\nTraceback: boom/,
			);
		});

		it('times out with the pod name and log when the port never opens', async () => {
			const world = makeWorld({
				execImpl: (cmd) => {
					if (cmd[2].includes('setsid')) return { stdout: '4242', stderr: '', exitCode: 0 };
					if (cmd[2].includes('connect_ex')) return { stdout: '', stderr: '', exitCode: 1 };
					if (cmd[2].startsWith('kill -0')) return { stdout: '', stderr: '', exitCode: 0 };
					if (cmd[2].includes('cat /tmp/mh-proc')) {
						return { stdout: 'still importing', stderr: '', exitCode: 0 };
					}
					return;
				},
			});
			const proc = await makeCompute(world).create(SANDBOX_ID).startProcess('run kernel');
			await expect(proc.waitForPort(2718, { timeout: 100 })).rejects.toThrow(
				/timed out waiting for port 2718 on pod mh-sb-abc after 100ms[\s\S]*still importing/,
			);
		});

		it('getLogs reads the launch log and kill sends the requested signal', async () => {
			const world = makeWorld({
				execImpl: (cmd) => {
					if (cmd[2].includes('setsid')) return { stdout: '4242\n', stderr: '', exitCode: 0 };
					if (cmd[2].includes('cat /tmp/mh-proc')) {
						return { stdout: 'kernel log', stderr: '', exitCode: 0 };
					}
					return;
				},
			});
			const proc = await makeCompute(world).create(SANDBOX_ID).startProcess('run kernel');

			await expect(proc.getLogs()).resolves.toEqual({ stdout: 'kernel log', stderr: '' });
			await proc.kill('KILL');

			const kill = world.execCalls.find((c) => shCmd(c).includes('kill -KILL 4242'));
			expect(kill).toBeDefined();
		});
	});

	describe('exposePort()', () => {
		it('returns the per-session subdomain URL by default', async () => {
			const world = makeWorld();
			const { url } = await makeCompute(world)
				.create(SANDBOX_ID)
				.exposePort(2718, { hostname: 'hub.example.com', token: 'sb-abc' });
			expect(url).toBe('https://sb-abc.hub.example.com');
		});

		it('honours a custom hostnameTemplate', async () => {
			const world = makeWorld();
			const { url } = await makeCompute(world, {
				...baseConfig,
				hostnameTemplate: 'https://{host}/s/{id}/{port}',
			})
				.create(SANDBOX_ID)
				.exposePort(2718, { hostname: 'hub.example.com' });
			expect(url).toBe('https://hub.example.com/s/sb-abc/2718');
		});

		it('substitutes the exposure token in a custom hostnameTemplate', async () => {
			const world = makeWorld();
			const { url } = await makeCompute(world, {
				...baseConfig,
				hostnameTemplate: 'https://{host}/proxy/{token}/{port}',
			})
				.create(SANDBOX_ID)
				.exposePort(2718, { hostname: 'hub.example.com', token: 'tok-123' });

			expect(url).toBe('https://hub.example.com/proxy/tok-123/2718');
		});
	});

	describe('destroy()', () => {
		it('deletes the session resources and is idempotent', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.exec('true');
			await inst.destroy();
			expect(world.deleted).toEqual([NAME]);
			await inst.destroy(); // re-resolve + delete again; fake tolerates the miss
			expect(world.deleted).toEqual([NAME, NAME]);
		});
	});

	describe('provider surface', () => {
		it('execStream exposes stdout as a readable stream', async () => {
			const world = makeWorld({
				execImpl: (cmd) =>
					cmd[2] === 'stream' ? { stdout: 'stream output', stderr: '', exitCode: 0 } : undefined,
			});

			const stream = await makeCompute(world).create(SANDBOX_ID).execStream('stream');

			expect(await new Response(stream).text()).toBe('stream output');
		});

		it('prefixes exec commands with accumulated environment variables', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);

			await inst.setEnvVars({ TOKEN: "a'b" });
			await inst.setEnvVars({ MODE: 'prod' });
			await inst.exec('echo "$TOKEN:$MODE"');

			const exec = world.execCalls.find((c) => shCmd(c).includes('echo "$TOKEN:$MODE"'));
			expect(shCmd(exec!)).toBe(
				"export TOKEN='a'\\''b'; export MODE='prod'; echo \"$TOKEN:$MODE\"",
			);
		});

		it('applies onlyIfUnset vars as guarded defaults after the forced exports', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);

			await inst.setEnvVars({ MODE: 'prod' });
			await inst.setEnvVars({ CACHE: '/tmp/c' }, { onlyIfUnset: true });
			await inst.exec('echo defaults');

			const exec = world.execCalls.find((c) => shCmd(c).includes('echo defaults'));
			expect(shCmd(exec!)).toBe(
				"export MODE='prod'; [ -n \"${CACHE:-}\" ] || export CACHE='/tmp/c'; echo defaults",
			);
		});

		it('proxy() is a no-op (kernel reached via its Ingress host)', async () => {
			const world = makeWorld();
			expect(await makeCompute(world).proxy(new Request('http://x/'))).toBeNull();
		});

		it('listActive() maps Pods back to SandboxIds and drops terminal ones', async () => {
			const world = makeWorld();
			const compute = makeCompute(world);
			await compute.create('sb-abc' as SandboxId).exec('true');
			await compute.create('sb-def' as SandboxId).exec('true');
			world.setPhase('mh-sb-def', 'Failed');

			const active = await compute.listActive();
			expect(active).toEqual([{ id: 'sb-abc', createdAt: '2020-01-01T00:00:00.000Z' }]);
		});
	});

	describe('boot observability', () => {
		const bootInfo: Omit<K8sPodPhaseInfo, 'phase'> = {
			uid: 'uid-1',
			createdAt: new Date(1000),
			scheduledAt: new Date(1080),
			readyAt: new Date(3300),
		};
		const imagePullMessage = 'Successfully pulled image "img" in 2.096s (2.5s including waiting)';

		it('drainTimings reports create/boot plus the cluster-side breakdown, once', async () => {
			const world = makeWorld({ bootInfo, imagePullMessage });
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.exec('true');
			const timings = inst.drainTimings!();
			expect(timings.create).toBeGreaterThanOrEqual(0);
			expect(timings.boot).toBeGreaterThanOrEqual(0);
			expect(timings).toMatchObject({ schedule: 80, pod_ready: 2300, image_pull: 2096 });
			expect(inst.drainTimings!()).toEqual({});
		});

		it('a reconnect skips the (stale) cluster-side breakdown', async () => {
			const world = makeWorld({ bootInfo, imagePullMessage });
			const compute = makeCompute(world);
			await compute.create(SANDBOX_ID).exec('true');
			// Same Pod, new instance — the breakdown belongs to the first boot.
			const reconnected = compute.create(SANDBOX_ID);
			await reconnected.exec('true');
			const timings = reconnected.drainTimings!();
			expect(timings.schedule).toBeUndefined();
			expect(timings.image_pull).toBeUndefined();
		});

		it('a hanging image-pull-event read cannot block readiness', async () => {
			vi.useFakeTimers();
			try {
				const world = makeWorld({ bootInfo });
				world.client.getImagePullMessage = () => new Promise(() => {});
				const inst = makeCompute(world).create(SANDBOX_ID);
				const ready = inst.ready!();
				await vi.advanceTimersByTimeAsync(1000);
				await ready;
				const timings = inst.drainTimings!();
				expect(timings.create).toBeGreaterThanOrEqual(0);
				// The poll-captured breakdown still lands; only the pull ms is missing.
				expect(timings.schedule).toBe(80);
				expect(timings.image_pull).toBeUndefined();
			} finally {
				vi.useRealTimers();
			}
		});

		it('drainCounters counts exec round-trips and resets on drain', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.exec('a');
			await inst.exec('b');
			expect(inst.drainCounters!()).toEqual({ execs: 2 });
			expect(inst.drainCounters!()).toEqual({ execs: 0 });
		});

		it('emits one structured k8s_ensure log line per boot', async () => {
			const world = makeWorld({ bootInfo, imagePullMessage });
			await makeCompute(world).create(SANDBOX_ID).exec('true');
			const lines = warnSpy.mock.calls
				.map((c: unknown[]) => c[0])
				.filter((s: unknown): s is string => typeof s === 'string' && s.includes('k8s_ensure'));
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0])).toMatchObject({
				event: 'k8s_ensure',
				sandbox_id: 'sb-abc',
				pod: NAME,
				namespace: 'default',
				created: true,
				schedule_ms: 80,
				image_pull_ms: 2096,
				pod_ready_ms: 2300,
				image_pull_event: imagePullMessage,
			});
		});
	});

	describe('gitCheckout', () => {
		it('shell-quotes the clone args (fixes the prior unquoted injection)', async () => {
			const world = makeWorld();
			// A malicious repo string that WOULD break out of the old unquoted command.
			await makeCompute(world)
				.create(SANDBOX_ID)
				.gitCheckout('https://x/y; rm -rf /', { branch: 'main', targetDir: 'w' });

			const git = world.execCalls.find((c) => shCmd(c).includes('git clone'));
			expect(shCmd(git!)).toBe("git clone --branch 'main' 'https://x/y; rm -rf /' 'w'");
		});

		it('throws when the clone fails', async () => {
			const world = makeWorld({
				execImpl: (cmd) =>
					cmd[2].includes('git clone') ? { stdout: '', stderr: 'fatal', exitCode: 1 } : undefined,
			});
			await expect(
				makeCompute(world).create(SANDBOX_ID).gitCheckout('https://x/y'),
			).rejects.toThrow(/git checkout failed/);
		});
	});
});

computeContract('KubernetesCompute', () => makeCompute(makeWorld()), { mountFallsBack: true });
