import { describe, expect, it } from 'vitest';
import { Millis } from '@marimo-hub/core';
import type { SandboxId } from '@marimo-hub/core';
import { computeContract } from '@marimo-hub/core/testing/compute-contract';
import { expectExecResult, expectFileResult } from '@marimo-hub/core/testing';
import { KubernetesCompute, resourceName } from './index';
import type { EnsureSandboxOptions, K8sClient, K8sExecResult, KubernetesConfig } from './index';

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

type ExecImpl = (command: string[], stdin?: string) => K8sExecResult | undefined;

function makeWorld(opts?: { execImpl?: ExecImpl; phase?: string }) {
	const ensured: EnsureSandboxOptions[] = [];
	const deleted: string[] = [];
	const execCalls: { name: string; command: string[]; stdin?: string }[] = [];
	const pods = new Map<string, { sandboxId: SandboxId; phase: string }>();

	const client: K8sClient = {
		ensure: async (o) => {
			ensured.push(o);
			if (!pods.has(o.name))
				pods.set(o.name, { sandboxId: o.sandboxId, phase: opts?.phase ?? 'Running' });
		},
		getPhase: async (name) => pods.get(name)?.phase,
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

/** The actual command string the adapter wraps in `['sh','-lc', …]`. */
const shCmd = (call: { command: string[] }) => call.command[2];

describe('resourceName', () => {
	it('derives a DNS-1123-safe name prefixed with mh-', () => {
		expect(resourceName('sb-abc' as SandboxId)).toBe('mh-sb-abc');
		expect(resourceName('SB_ABC.123' as SandboxId)).toBe('mh-sb-abc-123');
	});
});

describe('KubernetesCompute', () => {
	describe('exec()', () => {
		it('maps exit code 0 to success and shapes the command as sh -lc', async () => {
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
			await compute.create(SANDBOX_ID).writeFile('/workspace/notebooks/notebook.py', 'x=1');
			expect(world.execCalls.every((c) => c.name === NAME)).toBe(true);
		});

		it('passes resources, service account, and image pull secret through', async () => {
			const world = makeWorld();
			await makeCompute(world, {
				...baseConfig,
				serviceAccountName: 'marimo-kernel',
				imagePullSecret: 'regcred',
				resources: { cpu: '2', memory: '4Gi', gpu: '1' },
			})
				.create(SANDBOX_ID)
				.exec('true');
			expect(world.ensured[0]).toMatchObject({
				serviceAccountName: 'marimo-kernel',
				imagePullSecret: 'regcred',
				resources: { cpu: '2', memory: '4Gi', gpu: '1' },
			});
		});
	});

	describe('writeFile() / readFile()', () => {
		it('writeFile pipes content via stdin and mkdir -p the parent dir', async () => {
			const world = makeWorld();
			await makeCompute(world)
				.create(SANDBOX_ID)
				.writeFile('/workspace/notebooks/notebook.py', 'x=1');
			const call = world.execCalls.at(-1)!;
			expect(call.stdin).toBe('x=1');
			expect(shCmd(call)).toContain("mkdir -p '/workspace/notebooks'");
			expect(shCmd(call)).toContain("cat > '/workspace/notebooks/notebook.py'");
		});

		it('readFile returns file contents from the in-pod cat', async () => {
			const world = makeWorld({
				execImpl: (cmd) =>
					cmd[2].startsWith('cat -- ')
						? { stdout: 'print(1)', stderr: '', exitCode: 0 }
						: undefined,
			});
			const res = await makeCompute(world)
				.create(SANDBOX_ID)
				.readFile('/workspace/notebooks/notebook.py');
			expectFileResult(res, { success: true, content: 'print(1)', encoding: 'utf-8' });
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
		it('launches marimo detached and polls the in-pod port probe', async () => {
			let probes = 0;
			const world = makeWorld({
				execImpl: (cmd) => {
					if (cmd[2].includes('setsid')) return { stdout: '4242', stderr: '', exitCode: 0 };
					if (cmd[2].includes('connect_ex')) {
						probes++;
						return { stdout: '', stderr: '', exitCode: probes >= 2 ? 0 : 1 };
					}
					return;
				},
			});
			const inst = makeCompute(world).create(SANDBOX_ID);
			const proc = await inst.startProcess('uv run marimo edit --port 2718', { cwd: '/workspace' });
			await proc.waitForPort(2718, { timeout: 5000 });
			expect(probes).toBeGreaterThanOrEqual(2);

			const launch = world.execCalls.find((c) => shCmd(c).includes('setsid'))!;
			expect(shCmd(launch)).toContain("cd '/workspace'");
			expect(shCmd(launch)).toContain('uv run marimo edit --port 2718');
			expect(proc.id).toContain('4242');
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
