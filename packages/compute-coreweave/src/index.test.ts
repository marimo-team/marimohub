import { describe, it, expect } from 'vitest';
import { CWSandboxNotFoundError } from '@coreweave/cwsandbox';
import type { SandboxInfo } from '@coreweave/cwsandbox';
import type { SandboxId, SandboxProvider } from '@marimo-hub/core';
import { computeContract } from '@marimo-hub/core/testing/compute-contract';
import { expectExecResult, expectFileResult } from '@marimo-hub/core/testing';
import { coreWeaveProfileResources, CoreWeaveCompute } from './index';
import type { CoreWeaveClient, CoreWeaveConfig } from './index';
import { fakeProcess, makeWorld, procResult } from './testWorld';

/**
 * Tests for the CoreWeave compute adapter.
 *
 * Hermetic: the in-memory fake `CoreWeaveClient` from `testWorld.ts` is
 * injected via the constructor (no gRPC, no live creds), the cleanest analogue
 * of `compute-cloudflare`'s SDK-mock test.
 */

const SANDBOX_ID = 'sb-abc' as SandboxId;
const ID_TAG = 'mh-sbx-sb-abc';

const baseConfig: CoreWeaveConfig = { apiKey: 'key', image: 'my-image' };

function makeCompute(world: ReturnType<typeof makeWorld>, config: CoreWeaveConfig = baseConfig) {
	return new CoreWeaveCompute(config, world.client);
}

describe('CoreWeaveCompute', () => {
	describe('exec()', () => {
		it('maps exitCode 0 to success and shapes the command as sh -lc', async () => {
			const world = makeWorld();
			const result = await makeCompute(world).create(SANDBOX_ID).exec('echo hi');
			expectExecResult(result, { success: true, stdout: '', stderr: '' });
			const entry = [...world.registry.values()][0];
			expect(entry.fake.runCalls.at(-1)).toEqual(['sh', '-lc', 'echo hi']);
		});

		it('reports success=false on a non-zero exit', async () => {
			const world = makeWorld({ runImpl: async () => procResult({ exitCode: 1, stderr: 'boom' }) });
			const result = await makeCompute(world).create(SANDBOX_ID).exec('bad');
			expectExecResult(result, { success: false, stderr: 'boom' });
		});
	});

	describe('lazy create()', () => {
		it('declares our tags, the kernel port, and public ingress at create time', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID).exec('true');
			expect(world.created).toHaveLength(1);
			const opts = world.created[0];
			expect(opts.ports).toEqual([2718]);
			expect(opts.network).toMatchObject({
				ingressMode: 'public',
				egressMode: 'internet',
				exposedPorts: [2718],
			});
			expect(opts.tags).toEqual(['marimohub', ID_TAG]);
			expect(opts.containerImage).toBe('my-image');
			expect(opts.waitUntilRunning).toBe(true);
		});

		it('reuses the cached sandbox across calls (one create)', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.exec('a');
			await inst.exec('b');
			expect(world.created).toHaveLength(1);
		});

		it('passes configured profileNames and exposure modes at create time', async () => {
			const world = makeWorld();
			await makeCompute(world, {
				...baseConfig,
				profileNames: ['marimohub-sandbox'],
				ingressMode: 'public-edge',
				egressMode: 'restricted',
			})
				.create(SANDBOX_ID)
				.exec('true');
			const opts = world.created[0];
			expect(opts.profileNames).toEqual(['marimohub-sandbox']);
			expect(opts.network).toMatchObject({
				ingressMode: 'public-edge',
				egressMode: 'restricted',
			});
		});

		it('omits profileNames when none are configured (use runner default)', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID).exec('true');
			expect(world.created[0].profileNames).toBeUndefined();
		});

		it('a per-create image override replaces the configured containerImage', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID, { image: 'override-image' }).exec('true');
			expect(world.created[0].containerImage).toBe('override-image');
		});

		it('maps per-create resources to equal requests and limits', async () => {
			expect(coreWeaveProfileResources({})).toBeUndefined();
			expect(coreWeaveProfileResources({ cpu: 1.5, memoryBytes: 2 * 1024 ** 3 })).toEqual({
				requests: { cpu: '1.5', memory: '2048Mi' },
				limits: { cpu: '1.5', memory: '2048Mi' },
			});

			const world = makeWorld();
			await makeCompute(world)
				.create(SANDBOX_ID, {
					resources: { cpu: 1.5, memoryBytes: 2 * 1024 ** 3 },
				})
				.exec('true');
			expect(world.created[0].resources).toEqual({
				requests: { cpu: '1.5', memory: '2048Mi' },
				limits: { cpu: '1.5', memory: '2048Mi' },
			});
		});

		it('overlays only profile fields on configured resources', async () => {
			const world = makeWorld();
			await makeCompute(world, {
				...baseConfig,
				resources: {
					requests: { cpu: '2', memory: '4Gi' },
					limits: { cpu: '3', memory: '6Gi' },
				},
			})
				.create(SANDBOX_ID, { resources: { cpu: 1 } })
				.exec('true');
			expect(world.created[0].resources).toEqual({
				requests: { cpu: '1', memory: '4Gi' },
				limits: { cpu: '1', memory: '6Gi' },
			});
		});

		it('passes objectStorageAccess and endpoint env when buckets are configured', async () => {
			const world = makeWorld();
			await makeCompute(world, {
				...baseConfig,
				objectStorageBuckets: ['org-data', 'org-models'],
				objectStorageEndpoint: 'https://cwobject.com',
				objectStorageRegion: 'us-east-04a',
			})
				.create(SANDBOX_ID)
				.exec('true');
			const opts = world.created[0];
			expect(opts.objectStorageAccess).toEqual({
				buckets: ['org-data', 'org-models'],
				permission: 'read-write',
			});
			expect(opts.environmentVariables).toEqual({
				AWS_ENDPOINT_URL_S3: 'https://cwobject.com',
				AWS_REGION: 'us-east-04a',
			});
		});

		it('honors a read-only objectStoragePermission and omits env when unset', async () => {
			const world = makeWorld();
			await makeCompute(world, {
				...baseConfig,
				objectStorageBuckets: ['org-data'],
				objectStoragePermission: 'read',
			})
				.create(SANDBOX_ID)
				.exec('true');
			const opts = world.created[0];
			expect(opts.objectStorageAccess).toEqual({ buckets: ['org-data'], permission: 'read' });
			expect(opts.environmentVariables).toBeUndefined();
		});

		it('omits objectStorageAccess when no buckets are configured', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID).exec('true');
			expect(world.created[0].objectStorageAccess).toBeUndefined();
		});

		it('injects CAIOS environment variables without bucket access', async () => {
			const world = makeWorld();
			await makeCompute(world, {
				...baseConfig,
				objectStorageEndpoint: 'https://cwobject.com',
				objectStorageRegion: 'us-east-04a',
			})
				.create(SANDBOX_ID)
				.exec('true');
			const opts = world.created[0];
			expect(opts.objectStorageAccess).toBeUndefined();
			expect(opts.environmentVariables).toEqual({
				AWS_ENDPOINT_URL_S3: 'https://cwobject.com',
				AWS_REGION: 'us-east-04a',
			});
			const calls = world.registry.get('cw-1')!.fake.runCalls;
			expect(calls[0][2]).toContain('addressing_style = virtual');
		});

		it('bootstraps the AWS config for virtual-hosted addressing on fresh create', async () => {
			const world = makeWorld();
			await makeCompute(world, { ...baseConfig, objectStorageBuckets: ['org-data'] })
				.create(SANDBOX_ID)
				.exec('true');
			const calls = world.registry.get('cw-1')!.fake.runCalls;
			expect(calls[0][2]).toContain('addressing_style = virtual');
			expect(calls[0][2]).toContain('AWS_ENDPOINT_URL_S3');
			expect(calls).toHaveLength(2); // bootstrap, then the exec
		});

		it('skips the AWS config bootstrap without CAIOS configuration and on reconnect', async () => {
			const world = makeWorld();
			const compute = makeCompute(world, { ...baseConfig, objectStorageBuckets: ['org-data'] });
			await compute.create(SANDBOX_ID).exec('true');
			await compute.create(SANDBOX_ID).exec('true'); // reconnects to cw-1
			const bootstraps = world.registry
				.get('cw-1')!
				.fake.runCalls.filter((c) => c[2].includes('addressing_style'));
			expect(bootstraps).toHaveLength(1);

			const bare = makeWorld();
			await makeCompute(bare).create(SANDBOX_ID).exec('true');
			expect(bare.registry.get('cw-1')!.fake.runCalls).toHaveLength(1);
		});

		it('survives a failing AWS config bootstrap', async () => {
			const world = makeWorld({
				runImpl: async (command) => {
					if (command[2].includes('addressing_style')) throw new Error('exec transport lost');
					return procResult();
				},
			});
			const result = await makeCompute(world, { ...baseConfig, objectStorageBuckets: ['org-data'] })
				.create(SANDBOX_ID)
				.exec('true');
			expect(result.success).toBe(true);
		});
	});

	describe('re-resolved instance', () => {
		it('reconnects to the existing sandbox by tag instead of creating a new one', async () => {
			const world = makeWorld();
			const compute = makeCompute(world);
			await compute.create(SANDBOX_ID).exec('true'); // creates cw-1
			expect(world.created).toHaveLength(1);

			// A fresh instance (as the API does for teardown) must operate on cw-1.
			await compute.create(SANDBOX_ID).writeFiles([{ path: '/workspace/x', content: 'hi' }]);
			expect(world.created).toHaveLength(1); // no second create
			expect(world.registry.get('cw-1')!.fake.batchWrites.at(-1)![0]).toMatchObject({
				path: '/workspace/x',
				content: 'hi',
			});
		});
	});

	describe('reuse option', () => {
		it('default reuse lists (reconnect lookup) before creating', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID).exec('true');
			expect(world.listCalls).toEqual([[ID_TAG]]); // one reconnect lookup
			expect(world.created).toHaveLength(1);
		});

		it('reuse:false skips the reconnect list and creates directly', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID, { reuse: false }).exec('true');
			expect(world.listCalls).toEqual([]); // no wasted list on a fresh provision
			expect(world.created).toHaveLength(1);
		});
	});

	describe('writeFiles()', () => {
		it('collapses the per-file mkdirs into one exec, then writes the set in one call', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID, { reuse: false });

			await inst.writeFiles([
				{ path: '/w/notebook.py', content: 'import marimo' },
				{ path: '/w/data/a.csv', content: new Uint8Array([1, 2, 3]) },
				{ path: '/w/data/b.csv', content: 'x,y' },
			]);

			const fake = [...world.registry.values()][0].fake;
			// One mkdir covering both parents (deduped) — not one per file.
			const mkdirs = fake.runCalls.filter((c) => c[2]?.startsWith('mkdir -p '));
			expect(mkdirs).toHaveLength(1);
			expect(mkdirs[0][2]).toContain(`'/w'`);
			expect(mkdirs[0][2]).toContain(`'/w/data'`);
			// The whole set goes to the SDK in ONE write call, bytes passed through
			// verbatim (FileContent is string | Uint8Array — no base64 armoring).
			expect(fake.batchWrites).toHaveLength(1);
			expect(fake.batchWrites[0]).toEqual([
				{ path: '/w/notebook.py', content: 'import marimo' },
				{ path: '/w/data/a.csv', content: new Uint8Array([1, 2, 3]) },
				{ path: '/w/data/b.csv', content: 'x,y' },
			]);
		});

		it('is a no-op for an empty set', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID, { reuse: false }).writeFiles([]);
			expect(world.created).toHaveLength(0); // never even resolves the sandbox
		});
	});

	describe('drainTimings()', () => {
		it('returns the last ensure create/find ms, then clears', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID, { reuse: false });
			await inst.exec('true'); // triggers ensure()
			const timings = inst.drainTimings!();
			expect(timings).toHaveProperty('create');
			expect(timings).toHaveProperty('find');
			expect(typeof timings.create).toBe('number');
			// Drained once — a second drain is empty.
			expect(inst.drainTimings!()).toEqual({});
		});
	});

	describe('exposePort()', () => {
		it('builds the public URL from the default template', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.exec('true'); // creates cw-1
			const { url } = await inst.exposePort(2718, { hostname: 'hub.example.com', token: 'sb-abc' });
			expect(url).toBe('https://cw-1-2718.hub.example.com');
		});

		it('honors a custom hostnameTemplate', async () => {
			const world = makeWorld();
			const inst = makeCompute(world, {
				...baseConfig,
				hostnameTemplate: 'https://{host}/s/{sandboxId}/{port}',
			}).create(SANDBOX_ID);
			await inst.exec('true');
			const { url } = await inst.exposePort(2718, { hostname: 'hub.example.com' });
			expect(url).toBe('https://hub.example.com/s/cw-1/2718');
		});

		it('uses resolveExposedUrl over the template when configured', async () => {
			const world = makeWorld();
			const inst = makeCompute(world, {
				...baseConfig,
				resolveExposedUrl: async (sandboxId, port) => `http://10.0.0.9:${port}/${sandboxId}`,
			}).create(SANDBOX_ID);
			await inst.exec('true');
			const { url } = await inst.exposePort(2718, { hostname: 'ignored.example.com' });
			expect(url).toBe('http://10.0.0.9:2718/cw-1');
		});

		it('builds a wildcard per-sandbox subdomain (no {port}) for ingress host routing', async () => {
			const world = makeWorld();
			const inst = makeCompute(world, {
				...baseConfig,
				hostnameTemplate: 'https://{sandboxId}.{host}',
			}).create(SANDBOX_ID);
			await inst.exec('true');
			const { url } = await inst.exposePort(2718, {
				hostname: 'sandbox.86c6bc-marimo-hub.coreweave.app',
			});
			expect(url).toBe('https://cw-1.sandbox.86c6bc-marimo-hub.coreweave.app');
		});
	});

	describe('destroy()', () => {
		it('deletes the cached sandbox handle', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.exec('true');
			await inst.destroy();
			expect(world.deleted).toContain('cw-1');
		});

		it('re-resolves by id tag and deletes when there is no cached handle', async () => {
			const world = makeWorld();
			const compute = makeCompute(world);
			await compute.create(SANDBOX_ID).exec('true'); // creates cw-1
			await compute.create(SANDBOX_ID).destroy(); // fresh instance → list by tag → delete
			expect(world.deleted).toContain('cw-1');
		});
	});

	describe('startProcess().waitForPort()', () => {
		it('polls an in-sandbox probe until the port is ready', async () => {
			let probes = 0;
			const world = makeWorld({
				runImpl: async (cmd) => {
					if (cmd.join(' ').includes('connect_ex')) {
						probes++;
						return procResult({ exitCode: probes >= 2 ? 0 : 1 });
					}
					return procResult();
				},
			});
			const inst = makeCompute(world).create(SANDBOX_ID);
			const proc = await inst.startProcess('uv run marimo edit --port 2718');
			await proc.waitForPort(2718, { timeout: 5_000 });
			expect(probes).toBeGreaterThanOrEqual(2);
			const entry = [...world.registry.values()][0];
			expect(entry.fake.startCalls.at(-1)).toEqual(['sh', '-lc', 'uv run marimo edit --port 2718']);
		});
	});

	describe('mountBucket()', () => {
		it('throws so the provisioner falls back to file copy', async () => {
			const world = makeWorld();
			await expect(
				makeCompute(world).create(SANDBOX_ID).mountBucket({
					bucketName: 'b',
					endpoint: 'e',
					mountPath: '/m',
					prefix: 'p',
				}),
			).rejects.toThrow(/file copy/);
			expect(world.created).toHaveLength(0); // threw before creating anything
		});
	});

	describe('provider surface', () => {
		it('proxy() is a no-op (kernel reached via public ingress)', async () => {
			const world = makeWorld();
			expect(await makeCompute(world).proxy(new Request('http://x/'))).toBeNull();
		});

		it('throws on first use when neither an apiKey nor a client is provided', () => {
			expect(() => new CoreWeaveCompute({}).create(SANDBOX_ID)).toThrow(
				/apiKey.*or an injected client/,
			);
		});

		it('does not implement listActive (the list API cannot map back to our ids)', () => {
			const world = makeWorld();
			const provider: SandboxProvider = makeCompute(world);
			expect(provider.listActive).toBeUndefined();
		});
	});

	describe('gitCheckout()', () => {
		it('runs a shell-quoted git clone (injection-safe via compute-commons)', async () => {
			const world = makeWorld();
			await makeCompute(world)
				.create(SANDBOX_ID)
				.gitCheckout('https://x/y', { branch: 'main', targetDir: 'w' });
			const entry = [...world.registry.values()][0];
			expect(entry.fake.runCalls.at(-1)).toEqual([
				'sh',
				'-lc',
				"git clone --branch 'main' 'https://x/y' 'w'",
			]);
		});

		it('throws with stderr when the clone fails', async () => {
			const world = makeWorld({
				runImpl: async () => procResult({ exitCode: 128, stderr: 'fatal: repo not found' }),
			});
			await expect(
				makeCompute(world).create(SANDBOX_ID).gitCheckout('https://x/y'),
			).rejects.toThrow(/git checkout failed: fatal: repo not found/);
		});
	});

	describe('setEnvVars() + withEnv', () => {
		it('prefixes exec commands with shell-quoted exported env vars', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.setEnvVars({ TOKEN: "a'b", DIR: '/x' });
			await inst.exec('echo hi');
			const cmd = [...world.registry.values()][0].fake.runCalls.at(-1)![2];
			expect(cmd).toContain("export TOKEN='a'\\''b'; ");
			expect(cmd).toContain("export DIR='/x'; ");
			expect(cmd.endsWith('echo hi')).toBe(true);
		});

		it('merges across multiple setEnvVars calls', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.setEnvVars({ A: '1' });
			await inst.setEnvVars({ B: '2' });
			await inst.exec('run');
			const cmd = [...world.registry.values()][0].fake.runCalls.at(-1)![2];
			expect(cmd).toContain("export A='1'; ");
			expect(cmd).toContain("export B='2'; ");
		});
	});

	describe('listFiles()', () => {
		const findOutput = (lines: string[]) => `${lines.join('\n')}\n`;
		const onlyFind = (stdout: string, exitCode = 0) => ({
			runImpl: async (cmd: readonly string[]) =>
				cmd.join(' ').includes('find') ? procResult({ stdout, exitCode }) : procResult(),
		});

		it('parses find output into FileInfo, mapping types and filtering hidden files', async () => {
			const world = makeWorld(
				onlyFind(
					findOutput([
						'f\t10\t/workspace/a.py',
						'd\t4096\t/workspace/sub',
						'l\t0\t/workspace/link',
						'f\t5\t/workspace/.hidden',
					]),
				),
			);
			const res = await makeCompute(world).create(SANDBOX_ID).listFiles('/workspace');
			expect(res).toEqual({
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

		it('includes hidden files when includeHidden is set', async () => {
			const world = makeWorld(onlyFind(findOutput(['f\t5\t/workspace/.hidden'])));
			const res = await makeCompute(world)
				.create(SANDBOX_ID)
				.listFiles('/workspace', { includeHidden: true });
			expect(res.files.map((f) => f.name)).toEqual(['.hidden']);
		});

		it('returns success:false when the find command fails', async () => {
			const world = makeWorld(onlyFind('', 1));
			const res = await makeCompute(world).create(SANDBOX_ID).listFiles('/workspace');
			expect(res).toEqual({ success: false, files: [] });
		});
	});

	describe('readFile() / writeFiles()', () => {
		it('readFile returns content on success and swallows errors to success:false', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.exec('true'); // create cw-1
			world.registry.get('cw-1')!.fake.reads['/workspace/nb.py'] = 'print(1)';

			expectFileResult(await inst.readFile('/workspace/nb.py'), {
				success: true,
				content: 'print(1)',
				encoding: 'utf-8',
			});
			expectFileResult(await inst.readFile('/missing'), { success: false, content: '' });
		});

		it('writeFiles forwards path and content to the sandbox', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.writeFiles([{ path: '/workspace/out.py', content: 'data' }]);
			expect([...world.registry.values()][0].fake.batchWrites.at(-1)![0]).toMatchObject({
				path: '/workspace/out.py',
				content: 'data',
			});
		});

		it('writeFiles creates the parent directory first (nested path)', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.writeFiles([{ path: '/tmp/marimohub-config/marimo/marimo.toml', content: 'x' }]);
			const fake = [...world.registry.values()][0].fake;
			expect(
				fake.runCalls.some(
					(c) =>
						c.join(' ').includes('mkdir -p') &&
						c.join(' ').includes('/tmp/marimohub-config/marimo'),
				),
			).toBe(true);
			expect(fake.batchWrites.at(-1)![0]).toMatchObject({
				path: '/tmp/marimohub-config/marimo/marimo.toml',
				content: 'x',
			});
		});
	});

	describe('waitForPort timeout', () => {
		it('throws after the timeout when the probe never succeeds', async () => {
			const world = makeWorld({
				runImpl: async (cmd) =>
					cmd.join(' ').includes('connect_ex') ? procResult({ exitCode: 1 }) : procResult(),
			});
			const proc = await makeCompute(world).create(SANDBOX_ID).startProcess('run');
			await expect(proc.waitForPort(2718, { timeout: 40 })).rejects.toThrow(
				/timed out waiting for port 2718/,
			);
		});
	});

	describe('gateway failures & orphan cleanup', () => {
		it('create propagates a gateway create rejection (e.g. org wif-config NOT_FOUND)', async () => {
			const client: CoreWeaveClient = {
				create: async () => {
					throw new Error('NOT_FOUND: org wif-config not configured');
				},
				fromId: async () => {
					throw new Error('unused');
				},
				list: async () => ({ sandboxes: [] }),
				delete: async () => {},
			};
			await expect(
				new CoreWeaveCompute(baseConfig, client).create(SANDBOX_ID).exec('true'),
			).rejects.toThrow(/NOT_FOUND/);
		});

		it('writeFiles sends a large file via files.write and never places its bytes in an exec argv (ARG_MAX)', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID, { reuse: false });
			const big = new Uint8Array(1024 * 1024).fill(7);

			await inst.writeFiles([{ path: '/w/big.bin', content: big }]);

			const fake = [...world.registry.values()][0].fake;
			// The bytes ride the SDK write API verbatim…
			expect(fake.batchWrites.at(-1)![0].content).toBe(big);
			// …and no exec argv (only the small mkdir) carries them.
			for (const call of fake.runCalls) {
				expect(call[2].length).toBeLessThan(big.length);
			}
		});

		it('exposePort rejects when resolveExposedUrl throws', async () => {
			const world = makeWorld();
			const inst = makeCompute(world, {
				...baseConfig,
				resolveExposedUrl: async () => {
					throw new Error('gateway ip unavailable');
				},
			}).create(SANDBOX_ID);
			await inst.exec('true');
			await expect(inst.exposePort(2718, { hostname: 'h' })).rejects.toThrow(
				/gateway ip unavailable/,
			);
		});

		it('destroy deletes every sandbox tagged with our id (no orphan)', async () => {
			const world = makeWorld();
			const compute = makeCompute(world);
			// Two fresh provisions create two sandboxes carrying the same id tag.
			await compute.create(SANDBOX_ID, { reuse: false }).exec('true'); // cw-1
			await compute.create(SANDBOX_ID, { reuse: false }).exec('true'); // cw-2
			expect(world.created).toHaveLength(2);

			// A re-resolved instance (no cached handle) must delete BOTH.
			await compute.create(SANDBOX_ID).destroy();
			expect(world.deleted).toEqual(expect.arrayContaining(['cw-1', 'cw-2']));
		});

		it('destroy rethrows a non-NotFound delete error', async () => {
			const client: CoreWeaveClient = {
				create: async () => ({
					sandboxId: 'cw-x',
					commands: { run: async () => procResult(), start: async () => fakeProcess() },
					files: { readText: async () => '', write: async () => {} },
					delete: async () => {
						throw new Error('gRPC unavailable');
					},
				}),
				fromId: async (id) => ({
					sandboxId: id,
					commands: { run: async () => procResult(), start: async () => fakeProcess() },
					files: { readText: async () => '', write: async () => {} },
					delete: async () => {},
				}),
				list: async () => ({ sandboxes: [] }),
				delete: async () => {},
			};
			const inst = new CoreWeaveCompute(baseConfig, client).create(SANDBOX_ID);
			await inst.exec('true'); // caches the cw-x handle
			await expect(inst.destroy()).rejects.toThrow(/gRPC unavailable/);
		});
	});

	describe('reconnect / dead-status handling', () => {
		const bareSandbox = (sandboxId: string) => ({
			sandboxId,
			commands: { run: async () => procResult(), start: async () => fakeProcess() },
			files: { readText: async () => '', write: async () => {} },
			delete: async () => {},
		});

		it('skips a dead (terminated) tagged sandbox and creates a fresh one', async () => {
			let created = 0;
			const client: CoreWeaveClient = {
				create: async () => {
					created += 1;
					return bareSandbox(`cw-new`);
				},
				fromId: async (id) => bareSandbox(id),
				list: async () => ({
					sandboxes: [{ sandboxId: 'cw-dead', status: 'terminated' } as SandboxInfo],
				}),
				delete: async () => {},
			};
			await new CoreWeaveCompute(baseConfig, client).create(SANDBOX_ID).exec('true');
			expect(created).toBe(1); // did NOT reconnect to the dead sandbox
		});

		it('destroy tolerates CWSandboxNotFoundError (idempotent teardown)', async () => {
			const client: CoreWeaveClient = {
				create: async () => ({
					...bareSandbox('cw-gone'),
					delete: async () => {
						throw new CWSandboxNotFoundError('already gone');
					},
				}),
				fromId: async (id) => bareSandbox(id),
				list: async () => ({ sandboxes: [] }),
				delete: async () => {},
			};
			const inst = new CoreWeaveCompute(baseConfig, client).create(SANDBOX_ID);
			await inst.exec('true'); // create + cache cw-gone
			await expect(inst.destroy()).resolves.toBeUndefined();
		});
	});
});

computeContract('CoreWeaveCompute', () => makeCompute(makeWorld()), { mountFallsBack: true });
