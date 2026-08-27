import { describe, it, expect, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { CWSandboxNotFoundError } from '@coreweave/cwsandbox';
import type { SandboxInfo } from '@coreweave/cwsandbox';
import { NOT_A_DIRECTORY_EXIT_CODE, NOT_A_DIRECTORY_MARKER } from '@marimo-hub/compute-commons';
import type { SandboxId, SandboxProvider } from '@marimo-hub/core';
import {
	computeContract,
	isContractNonDirectoryFindCommand,
} from '@marimo-hub/core/testing/compute-contract';
import { listFilesFailure } from '@marimo-hub/core/ports';
import { expectExecResult, expectFileResult } from '@marimo-hub/core/testing';
import { coreWeaveProfileResources, CoreWeaveCompute } from './index';
import type { CoreWeaveClient, CoreWeaveConfig } from './index';
import { contractLaunchProcess, fakeProcess, makeWorld, procResult } from './testWorld';

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
		it('declares our tags and a public kernel service at create time', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID).exec('true');
			expect(world.created).toHaveLength(1);
			const opts = world.created[0];
			// No `endpoint`: v1 Create rejects a set product endpoint as unimplemented.
			expect(opts.services).toEqual([
				{ name: 'kernel', port: 2718, protocol: 'tcp', visibility: 'public' },
			]);
			expect(opts.tags).toEqual(['marimohub', ID_TAG]);
			expect(opts.containerImage).toBe('my-image');
			// The readiness wait is issued separately (see "boot wait"), so create
			// itself returns as soon as the backend accepts the start request.
			expect(opts.waitUntilRunning).toBe(false);
		});

		it('reuses the cached sandbox across calls (one create)', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.exec('a');
			await inst.exec('b');
			expect(world.created).toHaveLength(1);
		});

		it('correlates the ensure event with the active trace', async () => {
			const provider = new BasicTracerProvider();
			trace.setGlobalTracerProvider(provider);
			context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				await provider.getTracer('test').startActiveSpan('session-provision', async (span) => {
					try {
						const world = makeWorld();
						await makeCompute(world).create(SANDBOX_ID).exec('true');

						const event = warn.mock.calls
							.map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
							.find((record) => record.event === 'coreweave_ensure');
						expect(event).toMatchObject({
							trace_id: span.spanContext().traceId,
							span_id: span.spanContext().spanId,
						});
					} finally {
						span.end();
					}
				});
			} finally {
				warn.mockRestore();
				trace.disable();
				context.disable();
			}
		});

		it('passes configured runner ids at create time and omits them by default', async () => {
			const world = makeWorld();
			await makeCompute(world, { ...baseConfig, runnerIds: ['runner-a', 'runner-b'] })
				.create(SANDBOX_ID)
				.exec('true');
			expect(world.created[0].runnerIds).toEqual(['runner-a', 'runner-b']);

			const bare = makeWorld();
			await makeCompute(bare).create(SANDBOX_ID).exec('true');
			expect(bare.created[0].runnerIds).toBeUndefined();
		});

		it('pins a user-home sandbox to the user-home runner and exposes the email path safely', async () => {
			const world = makeWorld();
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				await makeCompute(world, {
					...baseConfig,
					runnerIds: ['runner-marimohub'],
					userHomeRunnerIds: ['runner-marimohub-user-home'],
				})
					.create(SANDBOX_ID, {
						userHome: { key: 'ada@example.com', path: '/mnt/ada@example.com' },
					})
					.exec('true');

				expect(world.created[0].runnerIds).toEqual(['runner-marimohub-user-home']);
				expect(world.created[0].environmentVariables).toMatchObject({
					MARIMOHUB_USER_HOME_KEY: 'ada@example.com',
				});
				const command = world.registry.get('cw-1')!.fake.runCalls[0][2];
				expect(command).toContain("if [ ! -d '/var/run/marimohub/user-home' ]");
				expect(command).toContain(
					'marimohub: user-home runner mount missing at /var/run/marimohub/user-home',
				);
				expect(command).toContain("ln -s '/var/run/marimohub/user-home' '/mnt/ada@example.com'");
				expect(command).toMatch(/; true$/);
				const ensureEvent = warn.mock.calls
					.map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
					.find((event) => event.event === 'coreweave_ensure');
				expect(ensureEvent).toMatchObject({
					runner_ids: ['runner-marimohub-user-home'],
					user_home_attached: true,
				});
				expect(ensureEvent).not.toHaveProperty('user_home_key');
				expect(JSON.stringify(ensureEvent)).not.toContain('ada@example.com');
			} finally {
				warn.mockRestore();
			}
		});

		it('merges user-home and object-storage environment variables', async () => {
			const world = makeWorld();
			await makeCompute(world, {
				...baseConfig,
				userHomeRunnerIds: ['runner-marimohub-user-home'],
				objectStorageEndpoint: 'https://cwobject.com',
				objectStorageRegion: 'us-east-04a',
			})
				.create(SANDBOX_ID, {
					userHome: { key: 'ada@example.com', path: '/mnt/ada@example.com' },
				})
				.exec('true');

			expect(world.created[0].environmentVariables).toEqual({
				AWS_ENDPOINT_URL_S3: 'https://cwobject.com',
				AWS_REGION: 'us-east-04a',
				MARIMOHUB_USER_HOME_KEY: 'ada@example.com',
			});
		});

		it('rejects a user home without a configured CoreWeave user-home runner', () => {
			const world = makeWorld();
			expect(() =>
				makeCompute(world).create(SANDBOX_ID, {
					userHome: { key: 'ada@example.com', path: '/mnt/ada@example.com' },
				}),
			).toThrow(/user-home runner is required/);
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

		it('bootstraps the AWS config on the first command, not a round-trip of its own', async () => {
			const world = makeWorld();
			await makeCompute(world, { ...baseConfig, objectStorageBuckets: ['org-data'] })
				.create(SANDBOX_ID)
				.exec('true');
			const calls = world.registry.get('cw-1')!.fake.runCalls;
			expect(calls).toHaveLength(1);
			expect(calls[0][2]).toContain('addressing_style = virtual');
			expect(calls[0][2]).toContain('AWS_ENDPOINT_URL_S3');
			expect(calls[0][2]).toContain('fi; true');
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

		it('a failing AWS config bootstrap does not sink the command it rides on', async () => {
			const world = makeWorld();
			const result = await makeCompute(world, { ...baseConfig, objectStorageBuckets: ['org-data'] })
				.create(SANDBOX_ID)
				.exec('true');
			expect(result.success).toBe(true);
			// Separated by `;`, never `&&`: the bootstrap is best-effort, so a non-zero
			// exit inside it must not short-circuit the command it was spliced onto.
			expect(world.registry.get('cw-1')!.fake.runCalls[0][2]).not.toContain('fi && ');
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
		it('writes the set in one call with no exec in front of it', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID, { reuse: false });

			await inst.writeFiles([
				{ path: '/w/notebook.py', content: 'import marimo' },
				{ path: '/w/data/a.csv', content: new Uint8Array([1, 2, 3]) },
				{ path: '/w/data/b.csv', content: 'x,y' },
			]);

			const fake = [...world.registry.values()][0].fake;
			// No mkdir round-trip: AddFile creates parents.
			expect(fake.runCalls).toHaveLength(0);
			expect(inst.drainCounters!()).toEqual({ execs: 0 });
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

		it('defers the armed bootstrap past writes outside the user home', async () => {
			const world = makeWorld();
			const inst = makeCompute(world, { ...baseConfig, objectStorageBuckets: ['org-data'] }).create(
				SANDBOX_ID,
				{ reuse: false },
			);
			await inst.writeFiles([{ path: '/workspace/notebook.py', content: 'x' }]);
			const fake = world.registry.get('cw-1')!.fake;
			expect(fake.runCalls).toHaveLength(0);
			// Bootstrap rides the next command.
			await inst.exec('true');
			expect(fake.runCalls).toHaveLength(1);
			expect(fake.runCalls[0][2]).toContain('addressing_style = virtual');
		});

		it('flushes the armed bootstrap before a write beneath the user home', async () => {
			const world = makeWorld();
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const inst = makeCompute(world, {
					...baseConfig,
					userHomeRunnerIds: ['runner-marimohub-user-home'],
				}).create(SANDBOX_ID, {
					reuse: false,
					userHome: { key: 'ada@example.com', path: '/mnt/ada@example.com' },
				});
				await inst.writeFiles([{ path: '/mnt/ada@example.com/notes.md', content: 'x' }]);
				const fake = world.registry.get('cw-1')!.fake;
				// Link first, or AddFile creates a plain dir in its place.
				expect(fake.runCalls).toHaveLength(1);
				expect(fake.runCalls[0][2]).toContain("ln -s '/var/run/marimohub/user-home'");
				expect(fake.batchWrites).toHaveLength(1);
				// Consumed once.
				await inst.exec('true');
				expect(fake.runCalls[1][2]).not.toContain('ln -s');
			} finally {
				warn.mockRestore();
			}
		});
	});

	describe('drainTimings()', () => {
		it('returns the last ensure find/create/boot ms, then clears', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID, { reuse: false });
			await inst.exec('true'); // triggers ensure()
			const timings = inst.drainTimings!();
			// `boot` is split from `create` so the wide event can tell a real container
			// start apart from time spent waiting on a status poll.
			expect(timings).toHaveProperty('find');
			expect(timings).toHaveProperty('create');
			expect(timings).toHaveProperty('boot');
			expect(typeof timings.create).toBe('number');
			// Drained once — a second drain is empty.
			expect(inst.drainTimings!()).toEqual({});
		});
	});

	describe('drainCounters()', () => {
		it('counts blocking commands, then clears', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID, { reuse: false });
			await inst.exec('true');
			await inst.exec('true');
			expect(inst.drainCounters!()).toEqual({ execs: 2 });
			expect(inst.drainCounters!()).toEqual({ execs: 0 });
		});
	});

	describe('boot wait', () => {
		it('waits explicitly after create (boot measured apart from create)', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID, { reuse: false }).exec('true');
			expect(world.created[0]).toMatchObject({ waitUntilRunning: false });
			expect(world.registry.get('cw-1')!.fake.waitCalls).toBe(1);
		});

		it('flags a boot over 10 s as a probable cold image pull', async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const world = makeWorld({
					waitImpl: async () => {
						vi.setSystemTime(Date.now() + 16_500);
					},
				});
				await makeCompute(world).create(SANDBOX_ID, { reuse: false }).exec('true');
				const ensureEvent = warn.mock.calls
					.map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
					.find((event) => event.event === 'coreweave_ensure');
				expect(ensureEvent).toMatchObject({
					boot_ms: 16_500,
					slow_boot_hint: expect.stringContaining('cold-pulled the sandbox image'),
				});
			} finally {
				warn.mockRestore();
				vi.useRealTimers();
			}
		});

		it('does not flag a warm-node boot', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				await makeCompute(makeWorld()).create(SANDBOX_ID, { reuse: false }).exec('true');
				const ensureEvent = warn.mock.calls
					.map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
					.find((event) => event.event === 'coreweave_ensure');
				expect(ensureEvent).toBeDefined();
				expect(ensureEvent).not.toHaveProperty('slow_boot_hint');
			} finally {
				warn.mockRestore();
			}
		});

		it('does not re-wait when reconnecting to a live sandbox', async () => {
			const world = makeWorld();
			const compute = makeCompute(world);
			await compute.create(SANDBOX_ID).exec('true');
			await compute.create(SANDBOX_ID).exec('true'); // reconnects to cw-1
			expect(world.registry.get('cw-1')!.fake.waitCalls).toBe(1);
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
				resolveExposedUrl: async (sandbox, port) => `http://10.0.0.9:${port}/${sandbox.sandboxId}`,
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

	describe('launchProcess()', () => {
		function streamedOutcome(event: 'ready' | 'setup_exit') {
			return async (command: readonly string[]) => {
				const nonce = command.join(' ').match(/'([a-f0-9]{32})'/)?.[1];
				if (!nonce) throw new Error('launch nonce missing from supervisor command');
				async function* stderr() {
					yield `kernel diagnostics\n__MARIMOHUB_LAUNCH_${nonce}__${JSON.stringify({
						event,
						setupMs: 17,
						waitportMs: event === 'ready' ? 23 : 0,
						...(event === 'setup_exit' ? { exitCode: 2 } : {}),
					})}\n`;
				}
				return { ...fakeProcess(), stderr: stderr() };
			};
		}

		it('uses one stream for setup, kernel launch, and readiness', async () => {
			const world = makeWorld({ startImpl: streamedOutcome('ready') });
			const inst = makeCompute(world).create(SANDBOX_ID, { reuse: false });
			const result = await inst.launchProcess!('uv run marimo edit', {
				setup: 'uv sync',
				cwd: '/workspace',
				port: 2718,
				startupTimeout: 120_000,
			});

			expect(result).toMatchObject({
				success: true,
				timings: { setup: 17, start: expect.any(Number), waitport: 23 },
			});
			const fake = world.registry.get('cw-1')!.fake;
			expect(fake.startCalls).toHaveLength(1);
			expect(fake.startCalls[0].join(' ')).toContain('uv sync');
			expect(fake.runCalls).toHaveLength(0);
		});

		it('succeeds when the ready marker and >64 KiB of trailing noise arrive in one chunk', async () => {
			const world = makeWorld({
				startImpl: async (command) => {
					const nonce = command.join(' ').match(/'([a-f0-9]{32})'/)?.[1];
					if (!nonce) throw new Error('launch nonce missing from supervisor command');
					async function* stderr() {
						// The noise evicts the marker from the capped tail before inspect()
						// runs; classification must come from the raw chunk.
						yield `__MARIMOHUB_LAUNCH_${nonce}__{"event":"ready","setupMs":6,"waitportMs":11}\n${'x'.repeat(70 * 1024)}\n`;
					}
					return { ...fakeProcess(), stderr: stderr() };
				},
			});
			const result = await makeCompute(world).create(SANDBOX_ID, { reuse: false }).launchProcess!(
				'marimo edit',
				{ port: 2718, startupTimeout: 120_000 },
			);

			expect(result).toMatchObject({
				success: true,
				timings: { setup: 6, start: expect.any(Number), waitport: 11 },
			});
		});

		it('returns a structured setup failure without a readiness Exec', async () => {
			const world = makeWorld({ startImpl: streamedOutcome('setup_exit') });
			const inst = makeCompute(world).create(SANDBOX_ID, { reuse: false });
			const result = await inst.launchProcess!('marimo edit', {
				setup: 'uv sync',
				port: 2718,
				startupTimeout: 120_000,
			});
			expect(result).toMatchObject({
				success: false,
				reason: 'setup_exit',
				exitCode: 2,
				stderr: 'kernel diagnostics\n',
			});
			expect(world.registry.get('cw-1')!.fake.runCalls).toHaveLength(0);
		});
	});

	describe('startProcess().waitForPort()', () => {
		it('waits in ONE in-sandbox command rather than one round-trip per probe', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			const proc = await inst.startProcess('uv run marimo edit --port 2718');
			await proc.waitForPort(2718, { timeout: 5_000 });

			// Probing from here cost a command round-trip per attempt on top of the
			// poll interval, which quantized the wait to that interval; the loop now
			// runs inside the sandbox and returns the moment the port binds.
			const waits = world.registry
				.get('cw-1')!
				.fake.runCalls.filter((c) => c[2].includes('connect_ex'));
			expect(waits).toHaveLength(1);
			expect(waits[0][2]).toContain('while');
			const entry = [...world.registry.values()][0];
			expect(entry.fake.startCalls.at(-1)).toEqual(['sh', '-lc', 'uv run marimo edit --port 2718']);
		});

		// A broken kernel command can exit before opening the port, and the wait would
		// otherwise run the full (2 minute) timeout. The SDK records an exit code ONLY
		// on a clean exit, so `failed` (a gRPC stream reset — see RUNBOOK H1) and
		// `cancelled` have to be recognised by status or they sail past a poll()-based check.
		it.each(['exited', 'failed', 'cancelled'] as const)(
			'a %s kernel is reported without burning the timeout',
			async (status) => {
				const world = makeWorld({
					proc: { status, ...(status === 'exited' ? { exitCode: 1 } : {}) },
				});
				const proc = await makeCompute(world).create(SANDBOX_ID).startProcess('marimo edit');
				await expect(proc.waitForPort(2718, { timeout: 120_000 })).rejects.toThrow(
					new RegExp(`${status} before port 2718`),
				);
			},
		);

		it('a waiter that fails instantly is reported, not re-issued until the deadline', async () => {
			// A broken waiter (no python3/date on the image) exits non-zero without
			// burning its chunk; retrying would hammer the command channel for the
			// whole timeout.
			const world = makeWorld({
				runImpl: async (cmd) =>
					cmd.join(' ').includes('connect_ex') ? procResult({ exitCode: 1 }) : procResult(),
			});
			const proc = await makeCompute(world).create(SANDBOX_ID).startProcess('marimo edit');
			await expect(proc.waitForPort(2718, { timeout: 5_000 })).rejects.toThrow(/timed out/);
			const waits = world.registry
				.get('cw-1')!
				.fake.runCalls.filter((c) => c[2].includes('connect_ex'));
			// Bounded by the chunk count, not by re-issuing until the deadline (which
			// at ~220ms per round-trip would be hundreds of commands).
			expect(waits.length).toBeLessThanOrEqual(3);
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

		it('applies onlyIfUnset vars as guarded defaults after the forced exports', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.setEnvVars({ A: '1' });
			await inst.setEnvVars({ CACHE: '/tmp/c' }, { onlyIfUnset: true });
			await inst.exec('run');
			const cmd = [...world.registry.values()][0].fake.runCalls.at(-1)![2];
			expect(cmd).toBe("export A='1'; [ -n \"${CACHE:-}\" ] || export CACHE='/tmp/c'; run");
		});
	});

	describe('listFiles()', () => {
		const findOutput = (lines: string[]) => `${lines.join('\0')}\0`;
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
			expect(res).toEqual(listFilesFailure());
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

		it('writeFiles leaves parent-directory creation to AddFile (nested path)', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.writeFiles([{ path: '/tmp/marimohub-config/marimo/marimo.toml', content: 'x' }]);
			const fake = [...world.registry.values()][0].fake;
			expect(fake.runCalls.some((c) => c.join(' ').includes('mkdir -p'))).toBe(false);
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
			// …and no exec carries them.
			expect(fake.runCalls).toHaveLength(0);
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
					wait: async () => {},
					commands: { run: async () => procResult(), start: async () => fakeProcess() },
					files: { readText: async () => '', write: async () => {} },
					delete: async () => {
						throw new Error('gRPC unavailable');
					},
				}),
				fromId: async (id) => ({
					sandboxId: id,
					wait: async () => {},
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
			wait: async () => {},
			commands: { run: async () => procResult(), start: async () => fakeProcess() },
			files: { readText: async () => '', write: async () => {} },
			delete: async () => {},
		});

		it('fails the provision when the sandbox completes during boot', async () => {
			// v1's wait() reports `completed` as a satisfied running-wait; the
			// adapter must turn that into a boot failure, not a working sandbox.
			const client: CoreWeaveClient = {
				create: async () => ({ ...bareSandbox('cw-done'), status: 'completed' as const }),
				fromId: async (id) => bareSandbox(id),
				list: async () => ({ sandboxes: [] }),
				delete: async () => {},
			};
			await expect(
				new CoreWeaveCompute(baseConfig, client).create(SANDBOX_ID).exec('true'),
			).rejects.toThrow(/completed before running/);
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

computeContract(
	'CoreWeaveCompute',
	() =>
		makeCompute(
			makeWorld({
				runImpl: async (command) => {
					if (command.at(-1)?.includes('mh-contract-fail')) {
						return procResult({ exitCode: 1, failed: true, ok: false, stderr: 'failed' });
					}
					if (isContractNonDirectoryFindCommand(command.at(-1))) {
						return procResult({
							exitCode: NOT_A_DIRECTORY_EXIT_CODE,
							failed: true,
							ok: false,
							stderr: NOT_A_DIRECTORY_MARKER,
						});
					}
					return procResult();
				},
				startImpl: async (command) => contractLaunchProcess(command) ?? fakeProcess(),
			}),
		),
	{ mountFallsBack: true, semantics: { failingCommand: 'mh-contract-fail', launch: {} } },
);
