import { describe, it, expect, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
	CWSandboxFailedError,
	CWSandboxNotFoundError,
	CWSandboxTerminatedError,
	CWSandboxTimeoutError,
	CWSandboxUnavailableError,
	CWSandboxConfigurationError,
	CWSandboxValidationError,
} from '@coreweave/cwsandbox';
import type { SandboxInfo } from '@coreweave/cwsandbox';
import { NOT_A_DIRECTORY_EXIT_CODE, NOT_A_DIRECTORY_MARKER } from '@marimo-hub/compute-commons';
import type { SandboxId } from '@marimo-hub/core/ids';
import type { SandboxProvider } from '@marimo-hub/core/ports/sandbox';
import {
	computeContract,
	isContractNonDirectoryFindCommand,
} from '@marimo-hub/core/testing/compute-contract';
import { listFilesFailure } from '@marimo-hub/core/ports/sandbox';
import { expectExecResult, expectFileResult } from '@marimo-hub/core/testing/result-assertions';
import { coreWeaveProfileResources, CoreWeaveCompute } from './index';
import type { CoreWeaveClient, CoreWeaveConfig } from './index';
import { contractLaunchProcess, fakeProcess, makeWorld, procResult } from './testWorld';
import { instrumentCoreWeaveClient } from './tracing';

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
/** Per-batch and process-wide file write concurrency. */
const WRITE_WAVE = 8;

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
			// No `endpoint` unless `kernelEndpoint` is configured.
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

		it('passes the configured runner id so creates target the CKS cluster', async () => {
			const world = makeWorld();
			await makeCompute(world, { ...baseConfig, runnerId: 'marimo-hub' })
				.create(SANDBOX_ID)
				.exec('true');
			expect(world.created[0].runnerIds).toEqual(['marimo-hub']);

			const bare = makeWorld();
			await makeCompute(bare).create(SANDBOX_ID).exec('true');
			expect(bare.created[0].runnerIds).toBeUndefined();
		});

		it('creates from the configured template with our tags, image, and keep-alive', async () => {
			const world = makeWorld();
			await makeCompute(world, {
				...baseConfig,
				runnerId: 'marimo-hub',
				templateId: 'tmpl-marimohub',
			})
				.create(SANDBOX_ID)
				.exec('true');

			expect(world.created).toHaveLength(0);
			expect(world.createdFromTemplate).toHaveLength(1);
			const { templateId, options } = world.createdFromTemplate[0];
			expect(templateId).toBe('tmpl-marimohub');
			// The id tag must replace the template's tags or reconnect breaks.
			expect(options.tags).toEqual(['marimohub', ID_TAG]);
			// The overlay must re-supply image + keep-alive (runFromTemplate injects
			// no command) so per-notebook image selection keeps working.
			expect(options.containerImage).toBe('my-image');
			expect(options.command).toBeDefined();
			expect(options.runnerIds).toEqual(['marimo-hub']);
			expect(options.waitUntilRunning).toBe(false);
		});

		it('creates from a template with objectStorageBuckets set (the template carries the access)', async () => {
			const world = makeWorld();
			await expect(
				makeCompute(world, {
					...baseConfig,
					templateId: 'tmpl-marimohub',
					objectStorageBuckets: ['org-data'],
				})
					.create(SANDBOX_ID)
					.exec('true'),
			).resolves.toMatchObject({ success: true });
		});

		it('provisions a user-home sandbox from the user-home template and exposes the email path safely', async () => {
			const world = makeWorld();
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				await makeCompute(world, {
					...baseConfig,
					templateId: 'tmpl-marimohub',
					userHomeTemplateId: 'tmpl-marimohub-user-home',
				})
					.create(SANDBOX_ID, {
						userHome: { key: 'ada@example.com', path: '/mnt/ada@example.com' },
					})
					.exec('true');

				expect(world.createdFromTemplate).toHaveLength(1);
				const { templateId, options } = world.createdFromTemplate[0];
				expect(templateId).toBe('tmpl-marimohub-user-home');
				expect(options.environmentVariables).toMatchObject({
					MARIMOHUB_USER_HOME_KEY: 'ada@example.com',
				});
				// The container overlay is what carries the env var `subPathExpr`
				// resolves; the template's attachment mounts survive it.
				expect(options.containerImage).toBe('my-image');
				expect(options.command).toBeDefined();
				const command = world.registry.get('cw-1')!.fake.runCalls[0][2];
				expect(command).toContain("if [ ! -d '/var/run/marimohub/user-home' ]");
				expect(command).toContain(
					'marimohub: user-home template mount missing at /var/run/marimohub/user-home',
				);
				expect(command).toContain("ln -s '/var/run/marimohub/user-home' '/mnt/ada@example.com'");
				expect(command).toMatch(/; true$/);
				const ensureEvent = warn.mock.calls
					.map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
					.find((event) => event.event === 'coreweave_ensure');
				expect(ensureEvent).toMatchObject({
					template_id: 'tmpl-marimohub-user-home',
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
				userHomeTemplateId: 'tmpl-marimohub-user-home',
				objectStorageEndpoint: 'https://cwobject.com',
				objectStorageRegion: 'us-east-04a',
			})
				.create(SANDBOX_ID, {
					userHome: { key: 'ada@example.com', path: '/mnt/ada@example.com' },
				})
				.exec('true');

			expect(world.createdFromTemplate[0].options.environmentVariables).toEqual({
				AWS_ENDPOINT_URL_S3: 'https://cwobject.com',
				AWS_REGION: 'us-east-04a',
				MARIMOHUB_USER_HOME_KEY: 'ada@example.com',
			});
		});

		it('rejects a user home without a configured CoreWeave user-home template', () => {
			const world = makeWorld();
			expect(() =>
				makeCompute(world).create(SANDBOX_ID, {
					userHome: { key: 'ada@example.com', path: '/mnt/ada@example.com' },
				}),
			).toThrow(/user-home template is required/);
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
		const endpointConfig: CoreWeaveConfig = {
			...baseConfig,
			kernelEndpoint: { kind: 'https', auth: 'open' },
			resolveExposedUrl: async (sandbox, port) =>
				sandbox.serviceUrls!.find((s) => s.port === port)!.url,
		};

		it('rejects a legacy HTTP endpoint without blocking file recovery or teardown', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID).ready!();
			world.registry.get('cw-1')!.fake.reads['/workspace/notebook.py'] = 'unsaved edits';
			const instance = makeCompute(world, endpointConfig).create(SANDBOX_ID);

			await expect(instance.exposePort(2718, { hostname: 'unused' })).rejects.toThrow(
				/expected HTTPS/,
			);
			await expect(instance.exposePort(2718, { hostname: 'unused' })).rejects.toThrow(
				/expected HTTPS/,
			);
			expectFileResult(await instance.readFile('/workspace/notebook.py'), {
				success: true,
				content: 'unsaved edits',
			});
			expect(world.created).toHaveLength(1);
			expect(world.deleted).toEqual([]);
			await instance.destroy();
			expect(world.deleted).toEqual(['cw-1']);
		});

		it('reuses an existing HTTPS endpoint', async () => {
			const world = makeWorld();
			await makeCompute(world, endpointConfig).create(SANDBOX_ID).ready!();
			const instance = makeCompute(world, endpointConfig).connectExisting(SANDBOX_ID);
			await expect(instance.exposePort(2718, { hostname: 'unused' })).resolves.toEqual({
				url: 'https://cw-1-2718.sandbox.test',
			});
			expect(world.created).toHaveLength(1);
		});

		it('rejects an HTTP URL even when a fresh sandbox requested an HTTPS endpoint', async () => {
			const world = makeWorld();
			const instance = makeCompute(world, {
				...endpointConfig,
				resolveExposedUrl: async () => 'http://legacy.sandbox.test:2718',
			}).create(SANDBOX_ID, { reuse: false });
			await expect(instance.exposePort(2718, { hostname: 'unused' })).rejects.toThrow(
				/expected HTTPS/,
			);
		});

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

	describe('provider id cache', () => {
		it('re-resolves a sandbox this process created by Get, without the tag List', async () => {
			const world = makeWorld();
			const compute = makeCompute(world);
			await compute.create(SANDBOX_ID, { reuse: false }).ready!();

			const reresolved = compute.create(SANDBOX_ID);
			await reresolved.exec('true');
			await compute.connectExisting(SANDBOX_ID).ready!();
			expect(world.listCalls).toEqual([]);
			expect(world.fromIdCalls).toEqual(['cw-1', 'cw-1']);
			expect(world.created).toHaveLength(1);
			expect(reresolved.drainTimings!()).toMatchObject({ find: 0, create: 0, boot: 0 });
		});

		it('remembers sandboxes found by tag or by saved reference', async () => {
			const world = makeWorld();
			const source = makeCompute(world).create(SANDBOX_ID, { reuse: false });
			await source.ready!();
			const other = 'sb-other' as SandboxId;
			await makeCompute(world).create(other, { reuse: false }).ready!();

			const compute = makeCompute(world);
			await compute.create(SANDBOX_ID).ready!();
			await compute.connectExisting(other, {
				reconnectReference: JSON.stringify({
					kind: 'coreweave-v1',
					hubId: other,
					sandboxId: 'cw-2',
				}),
			}).ready!();
			expect(world.listCalls).toEqual([[ID_TAG]]);
			await compute.create(SANDBOX_ID).ready!();
			await compute.create(other).ready!();
			expect(world.listCalls).toEqual([[ID_TAG]]);
		});

		it('falls back to the tag List on a cache miss', async () => {
			const world = makeWorld();
			await makeCompute(world).create(SANDBOX_ID, { reuse: false }).ready!();
			await makeCompute(world).create(SANDBOX_ID).ready!();
			expect(world.listCalls).toEqual([[ID_TAG]]);
			expect(world.created).toHaveLength(1);
		});

		it.each(['stopped', 'missing', 'mismatched'] as const)(
			'falls back to the tag List when the cached sandbox is %s',
			async (stale) => {
				const world = makeWorld();
				const fromId = world.client.fromId.bind(world.client);
				const compute = makeCompute(world);
				await compute.create(SANDBOX_ID, { reuse: false }).ready!();
				// Another replica replaced it with a sandbox under the same tag.
				await makeCompute(world).create(SANDBOX_ID, { reuse: false }).ready!();
				if (stale === 'stopped') world.registry.get('cw-1')!.fake.status = 'terminated';
				if (stale === 'missing') world.registry.delete('cw-1');
				if (stale === 'mismatched') {
					vi.spyOn(world.client, 'fromId').mockImplementationOnce(async () => fromId('cw-2'));
					world.registry.get('cw-1')!.fake.status = 'terminated';
				}

				const sandbox = compute.create(SANDBOX_ID);
				expectExecResult(await sandbox.exec('true'), { success: true });
				expect(world.listCalls).toEqual([[ID_TAG]]);
				expect(world.created).toHaveLength(2);
				expect(world.registry.get('cw-2')!.fake.runCalls).toHaveLength(1);
				await compute.create(SANDBOX_ID).ready!();
				expect(world.listCalls).toEqual([[ID_TAG]]);
			},
		);

		it('evicts a stale entry and never creates for connectExisting', async () => {
			const world = makeWorld();
			const compute = makeCompute(world);
			await compute.create(SANDBOX_ID, { reuse: false }).ready!();
			world.registry.get('cw-1')!.fake.status = 'terminated';

			await expect(compute.connectExisting(SANDBOX_ID).ready!()).rejects.toThrow(
				'no longer available',
			);
			await expect(compute.connectExisting(SANDBOX_ID).ready!()).rejects.toThrow(
				'no longer available',
			);
			expect(world.fromIdCalls).toEqual(['cw-1']);
			expect(world.listCalls).toEqual([[ID_TAG], [ID_TAG]]);
			expect(world.created).toHaveLength(1);
		});

		it('evicts on destroy', async () => {
			const world = makeWorld();
			const compute = makeCompute(world);
			await compute.create(SANDBOX_ID, { reuse: false }).ready!();
			await compute.create(SANDBOX_ID).destroy();
			expect(world.deleted).toEqual(['cw-1']);

			await compute.create(SANDBOX_ID).ready!();
			expect(world.fromIdCalls).toEqual([]);
			expect(world.created).toHaveLength(2);
		});

		it('keeps at most 4096 entries, dropping the least recently used', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const world = makeWorld();
				const compute = makeCompute(world);
				const id = (i: number) => `sb-bound-${i}` as SandboxId;
				for (let i = 0; i < 4096; i++) await compute.create(id(i), { reuse: false }).ready!();
				await compute.create(id(0)).ready!();
				await compute.create(id(4096), { reuse: false }).ready!();
				expect(world.listCalls).toEqual([]);

				await compute.create(id(0)).ready!();
				await compute.create(id(4096)).ready!();
				expect(world.listCalls).toEqual([]);
				await compute.create(id(1)).ready!();
				expect(world.listCalls).toEqual([[`mh-sbx-${id(1)}`]]);
			} finally {
				warn.mockRestore();
			}
		});
	});

	describe('writeFiles()', () => {
		it('writes the set with bounded single-file calls and no exec in front of it', async () => {
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
			// Bytes pass through verbatim; no base64 or file contents in exec argv.
			expect(fake.batchWrites).toHaveLength(3);
			expect(fake.batchWrites.flat()).toEqual([
				{ path: '/w/notebook.py', content: 'import marimo' },
				{ path: '/w/data/a.csv', content: new Uint8Array([1, 2, 3]) },
				{ path: '/w/data/b.csv', content: 'x,y' },
			]);
		});

		it('uploads two waves of files with one RPC per file', async () => {
			vi.useFakeTimers();
			try {
				let active = 0;
				let peak = 0;
				let started = 0;
				const world = makeWorld({
					writeImpl: async () => {
						started++;
						peak = Math.max(peak, ++active);
						await new Promise<void>((resolve) => setTimeout(resolve, 100));
						active--;
					},
				});
				const files = Array.from({ length: 2 * WRITE_WAVE }, (_, i) => ({
					path: `/w/${i}`,
					content: `${i}`,
				}));
				const write = makeCompute(world).create(SANDBOX_ID, { reuse: false }).writeFiles(files);
				await vi.advanceTimersByTimeAsync(99);
				expect(started).toBe(WRITE_WAVE);
				await vi.advanceTimersByTimeAsync(1);
				expect(started).toBe(2 * WRITE_WAVE);
				await vi.advanceTimersByTimeAsync(100);
				await write;
				expect(peak).toBe(WRITE_WAVE);
				expect(active).toBe(0);
				expect(world.registry.get('cw-1')!.fake.batchWrites.flat()).toEqual(files);
			} finally {
				vi.useRealTimers();
			}
		});

		it('caps concurrent uploads per sandbox while other sandboxes upload independently', async () => {
			vi.useFakeTimers();
			try {
				const active = { a: 0, b: 0 };
				const peak = { a: 0, b: 0 };
				const started = { a: 0, b: 0 };
				const world = makeWorld({
					writeImpl: async (files) => {
						const [file] = files as readonly { path: string }[];
						const key = file.path.startsWith('/a/') ? 'a' : 'b';
						started[key]++;
						peak[key] = Math.max(peak[key], ++active[key]);
						await new Promise<void>((resolve) => setTimeout(resolve, 100));
						active[key]--;
					},
				});
				const compute = makeCompute(world);
				const writes = (['a', 'b'] as const).map(async (key) => {
					const instance = compute.create(SANDBOX_ID, { reuse: false });
					await instance.ready!();
					await Promise.all(
						Array.from({ length: 3 }, (_, batch) =>
							instance.writeFiles(
								Array.from({ length: 4 }, (_, i) => ({
									path: `/${key}/${batch}/${i}`,
									content: 'x',
								})),
							),
						),
					);
				});
				await vi.advanceTimersByTimeAsync(99);
				expect(started).toEqual({ a: 8, b: 8 });
				await vi.advanceTimersByTimeAsync(101);
				await Promise.all(writes);
				expect(started).toEqual({ a: 12, b: 12 });
				expect(peak).toEqual({ a: 8, b: 8 });
				expect(active).toEqual({ a: 0, b: 0 });
			} finally {
				vi.useRealTimers();
			}
		});

		it('shares the upload cap across handles to the same sandbox', async () => {
			vi.useFakeTimers();
			try {
				let active = 0;
				let peak = 0;
				const world = makeWorld({
					writeImpl: async () => {
						peak = Math.max(peak, ++active);
						await new Promise<void>((resolve) => setTimeout(resolve, 100));
						active--;
					},
				});
				const compute = makeCompute(world);
				const created = compute.create(SANDBOX_ID, { reuse: false });
				await created.ready!();
				const connected = compute.connectExisting(SANDBOX_ID);
				await connected.ready!();
				const writes = [created, connected].flatMap((instance, handle) =>
					Array.from({ length: 3 }, (_, batch) =>
						instance.writeFiles(
							Array.from({ length: 4 }, (_, i) => ({
								path: `/${handle}/${batch}/${i}`,
								content: 'x',
							})),
						),
					),
				);
				await vi.advanceTimersByTimeAsync(400);
				await Promise.all(writes);
				expect(world.registry.size).toBe(1);
				expect(world.registry.get('cw-1')!.fake.batchWrites).toHaveLength(24);
				expect(peak).toBe(8);
			} finally {
				vi.useRealTimers();
			}
		});

		it('forwards the write deadline through the instrumented client', async () => {
			const timeouts: (number | undefined)[] = [];
			const world = makeWorld({
				writeImpl: async (_files, options) => {
					timeouts.push(options?.timeoutMs);
				},
			});
			const client = instrumentCoreWeaveClient(world.client, 'https://gateway.example');
			await new CoreWeaveCompute(baseConfig, client)
				.create(SANDBOX_ID, { reuse: false })
				.writeFiles([{ path: '/w/x', content: 'x' }]);
			expect(timeouts).toEqual([60_000]);
		});

		it('fails a hung write at its deadline and releases its upload slot', async () => {
			vi.useFakeTimers();
			try {
				const timeouts: (number | undefined)[] = [];
				const world = makeWorld({
					writeImpl: async (files, options) => {
						timeouts.push(options?.timeoutMs);
						const [file] = files as readonly { path: string }[];
						if (file.path.startsWith('/hung/')) await new Promise<never>(() => {});
					},
				});
				const instance = makeCompute(world).create(SANDBOX_ID, { reuse: false });
				await instance.ready!();
				const hung = Array.from({ length: 8 }, (_, i) =>
					expect(
						instance.writeFiles([{ path: `/hung/${i}`, content: 'x' }]),
					).rejects.toBeInstanceOf(CWSandboxTimeoutError),
				);
				let healthyFinished = false;
				const healthy = instance.writeFiles([{ path: '/healthy', content: 'x' }]).then(() => {
					healthyFinished = true;
				});
				await vi.advanceTimersByTimeAsync(59_999);
				expect(healthyFinished).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
				await Promise.all([...hung, healthy]);
				expect(timeouts).toEqual(Array.from({ length: 9 }, () => 60_000));
				expect(world.registry.get('cw-1')!.fake.batchWrites.flat()).toEqual([
					{ path: '/healthy', content: 'x' },
				]);
			} finally {
				vi.useRealTimers();
			}
		});

		it.each(['relative', '', '/w/duplicate'])(
			'validates the entire set before writing: %j',
			async (path) => {
				const world = makeWorld();
				const files = [
					{ path: '/w/duplicate', content: 'first' },
					{ path, content: 'second' },
				];
				await expect(
					makeCompute(world).create(SANDBOX_ID).writeFiles(files),
				).rejects.toBeInstanceOf(CWSandboxValidationError);
				expect(world.created).toHaveLength(0);
			},
		);

		it('keeps validated destinations stable while lazy sandbox readiness is pending', async () => {
			let ready!: () => void;
			const world = makeWorld({
				pollImpl: () =>
					new Promise<void>((resolve) => {
						ready = resolve;
					}),
			});
			const files = [{ path: '/w/original', content: 'x' }];
			const write = makeCompute(world).create(SANDBOX_ID, { reuse: false }).writeFiles(files);
			await vi.waitFor(() => expect(ready).toBeDefined());
			files[0].path = 'relative-after-validation';
			ready();
			await write;
			expect(world.registry.get('cw-1')!.fake.batchWrites.flat()).toEqual([
				{ path: '/w/original', content: 'x' },
			]);
		});

		it('drains active writes after failure and does not dispatch the remaining files', async () => {
			let started = 0;
			const releases: (() => void)[] = [];
			const world = makeWorld({
				writeImpl: async () => {
					const index = started++;
					if (index === 0) throw new Error('permission denied');
					await new Promise<void>((resolve) => releases.push(resolve));
				},
			});
			const files = Array.from({ length: 2 * WRITE_WAVE }, (_, i) => ({
				path: `/w/${i}`,
				content: 'x',
			}));
			const write = makeCompute(world).create(SANDBOX_ID, { reuse: false }).writeFiles(files);
			let rejected = false;
			const checked = expect(write)
				.rejects.toThrow('permission denied')
				.then(() => {
					rejected = true;
				});
			await vi.waitFor(() => expect(started).toBe(WRITE_WAVE));
			expect(rejected).toBe(false);
			for (const release of releases) release();
			await checked;
			expect(started).toBe(WRITE_WAVE);
		});

		it('skips queued uploads after a permanent error without stopping other batches', async () => {
			vi.useFakeTimers();
			const error = new Error('permission denied');
			let releaseBlockers!: () => void;
			const blocked = new Promise<void>((resolve) => {
				releaseBlockers = resolve;
			});
			let blockersStarted = 0;
			const attempted: string[] = [];
			const world = makeWorld({
				writeImpl: async (files) => {
					const [file] = files as readonly { path: string }[];
					if (file.path.startsWith('/blocker/')) {
						blockersStarted++;
						await blocked;
						return;
					}
					attempted.push(file.path);
					if (file.path === '/w/0') throw error;
				},
			});
			const instance = makeCompute(world).create(SANDBOX_ID, { reuse: false });
			await instance.ready!();
			const blockers = Promise.all(
				Array.from({ length: 7 }, (_, i) =>
					instance.writeFiles([{ path: `/blocker/${i}`, content: 'x' }]),
				),
			);
			try {
				await vi.advanceTimersByTimeAsync(0);
				expect(blockersStarted).toBe(7);
				const rejected = expect(
					instance.writeFiles(
						Array.from({ length: 8 }, (_, i) => ({ path: `/w/${i}`, content: 'x' })),
					),
				).rejects.toBe(error);
				const otherBatch = instance.writeFiles([{ path: '/other-batch', content: 'x' }]);
				await vi.advanceTimersByTimeAsync(0);
				await Promise.all([rejected, otherBatch]);
				expect(attempted).toEqual(['/w/0', '/other-batch']);
				await instance.writeFiles([{ path: '/w/next-batch', content: 'x' }]);
				expect(attempted.at(-1)).toBe('/w/next-batch');
			} finally {
				releaseBlockers();
				await blockers;
				vi.useRealTimers();
			}
		});

		it('drains exhausted retries without starting the rest of the batch', async () => {
			vi.useFakeTimers();
			try {
				const error = new CWSandboxUnavailableError('unavailable');
				const attempts: string[] = [];
				const world = makeWorld({
					writeImpl: async (files) => {
						const [file] = files as readonly { path: string }[];
						if (file.path === '/healthy') return;
						attempts.push(file.path);
						throw error;
					},
				});
				const instance = makeCompute(world).create(SANDBOX_ID, { reuse: false });
				const rejected = expect(
					instance.writeFiles(
						Array.from({ length: 2 * WRITE_WAVE }, (_, i) => ({ path: `/w/${i}`, content: 'x' })),
					),
				).rejects.toBe(error);
				await vi.runAllTimersAsync();
				await rejected;
				expect(attempts).toHaveLength(4 * WRITE_WAVE);
				for (let i = 0; i < WRITE_WAVE; i++) {
					expect(attempts.filter((attempt) => attempt === `/w/${i}`)).toHaveLength(4);
				}
				await instance.writeFiles([{ path: '/healthy', content: 'x' }]);
			} finally {
				await vi.runAllTimersAsync();
				vi.useRealTimers();
			}
		});

		it.each(['success', 'failure'] as const)(
			'preserves the first error while draining an active retry to %s',
			async (outcome) => {
				vi.useFakeTimers();
				try {
					const firstError = new Error('permission denied');
					const laterError = new Error('disk full');
					const attempts: string[] = [];
					const world = makeWorld({
						writeImpl: async (files) => {
							const [file] = files as readonly { path: string }[];
							attempts.push(file.path);
							if (file.path === '/w/0') {
								await new Promise<void>((resolve) => setTimeout(resolve, 10));
								throw firstError;
							}
							if (file.path === '/w/1') {
								if (attempts.filter((path) => path === file.path).length === 1) {
									throw new CWSandboxUnavailableError('unavailable');
								}
								if (outcome === 'failure') throw laterError;
								return;
							}
							await new Promise<void>((resolve) => setTimeout(resolve, 50));
						},
					});
					const firstWave = Array.from({ length: WRITE_WAVE }, (_, i) => `/w/${i}`);
					const write = makeCompute(world)
						.create(SANDBOX_ID, { reuse: false })
						.writeFiles(
							Array.from({ length: 2 * WRITE_WAVE }, (_, i) => ({ path: `/w/${i}`, content: 'x' })),
						);
					let rejected = false;
					const checked = expect(write)
						.rejects.toBe(firstError)
						.then(() => {
							rejected = true;
						});
					await vi.advanceTimersByTimeAsync(249);
					expect(rejected).toBe(false);
					expect(attempts).toEqual(firstWave);
					await vi.advanceTimersByTimeAsync(1);
					await checked;
					expect(attempts).toEqual([...firstWave, '/w/1']);
					const written = world.registry
						.get('cw-1')!
						.fake.batchWrites.flat()
						.map((file) => file.path);
					expect(written.sort()).toEqual(firstWave.slice(outcome === 'success' ? 1 : 2).sort());
				} finally {
					await vi.runAllTimersAsync();
					vi.useRealTimers();
				}
			},
		);

		it('does not upload files when sandbox readiness fails', async () => {
			const error = new Error('boot failed');
			const writeImpl = vi.fn(async () => {});
			const world = makeWorld({
				pollImpl: async () => {
					throw error;
				},
				writeImpl,
			});
			await expect(
				makeCompute(world)
					.create(SANDBOX_ID, { reuse: false })
					.writeFiles([{ path: '/w/notebook.py', content: 'x' }]),
			).rejects.toBe(error);
			expect(writeImpl).not.toHaveBeenCalled();
		});

		it('retries a write the gateway answers with UNAVAILABLE', async () => {
			vi.useFakeTimers();
			try {
				let failures = 2;
				const world = makeWorld({
					writeImpl: async () => {
						if (failures-- > 0) throw new CWSandboxUnavailableError('W&B server error: 503');
					},
				});
				const inst = makeCompute(world).create(SANDBOX_ID, { reuse: false });
				const write = inst.writeFiles([{ path: '/tmp/token', content: 'x' }]);
				await vi.runAllTimersAsync();
				await write;
				expect([...world.registry.values()][0].fake.batchWrites).toEqual([
					[{ path: '/tmp/token', content: 'x' }],
				]);
			} finally {
				vi.useRealTimers();
			}
		});

		it('releases upload slots while unavailable files wait for retry', async () => {
			vi.useFakeTimers();
			try {
				const seen = new Set<string>();
				const world = makeWorld({
					writeImpl: async (files) => {
						const [file] = files as readonly { path: string }[];
						if (file.path.startsWith('/retry/') && !seen.has(file.path)) {
							seen.add(file.path);
							throw new CWSandboxUnavailableError('temporarily unavailable');
						}
					},
				});
				const instance = makeCompute(world).create(SANDBOX_ID, { reuse: false });
				await instance.ready!();
				const retries = Promise.all(
					Array.from({ length: 16 }, (_, i) =>
						instance.writeFiles([{ path: `/retry/${i}`, content: 'x' }]),
					),
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(seen.size).toBe(16);
				let healthyFinished = false;
				const healthy = instance.writeFiles([{ path: '/healthy', content: 'x' }]).then(() => {
					healthyFinished = true;
				});
				await vi.advanceTimersByTimeAsync(0);
				expect(healthyFinished).toBe(true);
				await vi.runAllTimersAsync();
				await Promise.all([retries, healthy]);
			} finally {
				vi.useRealTimers();
			}
		});

		it('retries only unavailable files, without re-uploading successful siblings', async () => {
			vi.useFakeTimers();
			try {
				const attempts: string[] = [];
				const world = makeWorld({
					writeImpl: async (files) => {
						const [file] = files as readonly { path: string }[];
						attempts.push(file.path);
						if (
							file.path === '/w/retry' &&
							attempts.filter((path) => path === file.path).length === 1
						) {
							throw new CWSandboxUnavailableError('temporarily unavailable');
						}
					},
				});
				const write = makeCompute(world)
					.create(SANDBOX_ID, { reuse: false })
					.writeFiles([
						{ path: '/w/ok', content: 'a' },
						{ path: '/w/retry', content: 'b' },
					]);
				await vi.runAllTimersAsync();
				await write;
				expect(attempts.filter((path) => path === '/w/ok')).toHaveLength(1);
				expect(attempts.filter((path) => path === '/w/retry')).toHaveLength(2);
			} finally {
				vi.useRealTimers();
			}
		});

		it('gives up on UNAVAILABLE once the backoff is exhausted', async () => {
			vi.useFakeTimers();
			try {
				let attempts = 0;
				const world = makeWorld({
					writeImpl: async () => {
						attempts++;
						throw new CWSandboxUnavailableError('W&B server error: 503');
					},
				});
				const write = makeCompute(world)
					.create(SANDBOX_ID, { reuse: false })
					.writeFiles([{ path: '/tmp/token', content: 'x' }]);
				const rejected = expect(write).rejects.toBeInstanceOf(CWSandboxUnavailableError);
				await vi.runAllTimersAsync();
				await rejected;
				expect(attempts).toBe(4);
			} finally {
				vi.useRealTimers();
			}
		});

		it('stops retrying when UNAVAILABLE changes to a permanent error', async () => {
			vi.useFakeTimers();
			try {
				const error = new Error('permission denied');
				const writeImpl = vi
					.fn<() => Promise<void>>()
					.mockRejectedValueOnce(new CWSandboxUnavailableError('unavailable'))
					.mockRejectedValueOnce(error)
					.mockResolvedValue(undefined);
				const instance = makeCompute(makeWorld({ writeImpl })).create(SANDBOX_ID, { reuse: false });
				const rejected = expect(
					instance.writeFiles([{ path: '/w/retry', content: 'x' }]),
				).rejects.toBe(error);
				await vi.runAllTimersAsync();
				await rejected;
				expect(writeImpl).toHaveBeenCalledTimes(2);
				await instance.writeFiles([{ path: '/w/next-batch', content: 'x' }]);
				expect(writeImpl).toHaveBeenCalledTimes(3);
			} finally {
				vi.useRealTimers();
			}
		});

		it('does not retry other write failures', async () => {
			let attempts = 0;
			const world = makeWorld({
				writeImpl: async () => {
					attempts++;
					throw new Error('permission denied');
				},
			});
			await expect(
				makeCompute(world)
					.create(SANDBOX_ID, { reuse: false })
					.writeFiles([{ path: '/tmp/token', content: 'x' }]),
			).rejects.toThrow('permission denied');
			expect(attempts).toBe(1);
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
					userHomeTemplateId: 'tmpl-marimohub-user-home',
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
			expect(world.registry.get('cw-1')!.fake.statusPolls).toBe(1);
		});

		it('flags a boot over 10 s as a probable cold image pull', async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const world = makeWorld({
					pollImpl: async () => {
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
			expect(world.registry.get('cw-1')!.fake.statusPolls).toBe(1);
		});

		it('notices running within one 250 ms poll interval, without busy polling', async () => {
			vi.useFakeTimers();
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const world = makeWorld({ bootStatus: 'pending' });
				let ready = false;
				const waiting = makeCompute(world).create(SANDBOX_ID, { reuse: false }).ready!().then(
					() => {
						ready = true;
					},
				);
				await vi.advanceTimersByTimeAsync(0);
				const fake = world.registry.get('cw-1')!.fake;
				expect(fake.statusPolls).toBe(1);
				await vi.advanceTimersByTimeAsync(249);
				expect(fake.statusPolls).toBe(1);
				await vi.advanceTimersByTimeAsync(701);
				expect(fake.statusPolls).toBe(4);
				fake.status = 'running';
				await vi.advanceTimersByTimeAsync(49);
				expect(ready).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
				await waiting;
				expect(fake.statusPolls).toBe(5);
				const ensureEvent = warn.mock.calls
					.map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
					.find((event) => event.event === 'coreweave_ensure');
				expect(ensureEvent).toMatchObject({ reconnected: false, create_ms: 0, boot_ms: 1_000 });
			} finally {
				warn.mockRestore();
				vi.useRealTimers();
			}
		});

		it('times out after 60 s of boot polling', async () => {
			vi.useFakeTimers();
			try {
				const world = makeWorld({ bootStatus: 'creating' });
				let error: unknown;
				const waiting = makeCompute(world).create(SANDBOX_ID, { reuse: false }).ready!().catch(
					(caught: unknown) => {
						error = caught;
					},
				);
				await vi.advanceTimersByTimeAsync(59_999);
				expect(error).toBeUndefined();
				await vi.advanceTimersByTimeAsync(1);
				await waiting;
				expect(error).toBeInstanceOf(CWSandboxTimeoutError);
				expect(world.registry.get('cw-1')!.fake.statusPolls).toBe(240);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it.each([
			['failed', CWSandboxFailedError],
			['terminated', CWSandboxTerminatedError],
			['terminating', CWSandboxTerminatedError],
		] as const)('rejects a sandbox that is %s during boot', async (status, ErrorType) => {
			const world = makeWorld({ bootStatus: status });
			await expect(
				makeCompute(world).create(SANDBOX_ID, { reuse: false }).ready!(),
			).rejects.toBeInstanceOf(ErrorType);
			expect(world.registry.get('cw-1')!.fake.statusPolls).toBe(1);
		});

		it('fails fast when a booting sandbox starts terminating', async () => {
			vi.useFakeTimers();
			try {
				const world = makeWorld({ bootStatus: 'creating' });
				let error: unknown;
				const waiting = makeCompute(world).create(SANDBOX_ID, { reuse: false }).ready!().catch(
					(caught: unknown) => {
						error = caught;
					},
				);
				await vi.advanceTimersByTimeAsync(0);
				const fake = world.registry.get('cw-1')!.fake;
				expect(fake.statusPolls).toBe(1);
				fake.status = 'terminating';
				await vi.advanceTimersByTimeAsync(250);
				await waiting;
				expect(error).toBeInstanceOf(CWSandboxTerminatedError);
				expect(fake.statusPolls).toBe(2);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it('retries transient status errors with backoff', async () => {
			vi.useFakeTimers();
			try {
				let failures = 2;
				const world = makeWorld({
					pollImpl: async () => {
						if (failures-- > 0) throw new CWSandboxUnavailableError('unavailable');
					},
				});
				const waiting = makeCompute(world).create(SANDBOX_ID, { reuse: false }).ready!();
				await vi.advanceTimersByTimeAsync(0);
				const fake = world.registry.get('cw-1')!.fake;
				expect(fake.statusPolls).toBe(1);
				await vi.advanceTimersByTimeAsync(250);
				expect(fake.statusPolls).toBe(2);
				await vi.advanceTimersByTimeAsync(499);
				expect(fake.statusPolls).toBe(2);
				await vi.advanceTimersByTimeAsync(1);
				await waiting;
				expect(fake.statusPolls).toBe(3);
			} finally {
				vi.useRealTimers();
			}
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
				hostname: 'sandbox.example.com',
			});
			expect(url).toBe('https://cw-1.sandbox.example.com');
		});
	});

	describe('destroy()', () => {
		it('prepares retained environment values at a new path when the same instance recreates its sandbox', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.setEnvVars({ TOKEN: 'secret' });
			await inst.setEnvVars({ CACHE: '/tmp/cache' }, { onlyIfUnset: true });
			await inst.exec('first');
			await inst.exec('second');
			const original = world.registry.get('cw-1')!.fake;
			expect(original.stdinWrites).toHaveLength(1);
			await inst.destroy();
			expect(world.registry.size).toBe(0);
			await inst.exec('first');
			await inst.exec('second');
			const recreated = world.registry.get('cw-2')!.fake;

			expect(world.created).toHaveLength(2);
			expect(recreated.stdinWrites).toEqual([
				"export TOKEN='secret'; [ -n \"${CACHE+x}\" ] || export CACHE='/tmp/cache'; ",
			]);
			expect(recreated.stdinWrites).toEqual(original.stdinWrites);
			const newPath = recreated.startCalls[0][2].match(/cat > '([^']+)'/)?.[1];
			expect(newPath).toMatch(/^\/tmp\/marimohub-env-.+\/env.sh$/);
			expect(original.runCalls.at(-1)![2]).not.toContain(newPath);
			expect(recreated.runCalls.at(-1)![2]).toContain(`. '${newPath}'`);
		});

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

	describe('extra surface ports', () => {
		it('advertises multiPort exactly when extra ports are configured', () => {
			const world = makeWorld();
			expect(makeCompute(world, baseConfig).capabilities).toEqual({ multiPort: false });
			expect(makeCompute(world, { ...baseConfig, extraPorts: [8443] }).capabilities).toEqual({
				multiPort: true,
			});
		});

		it('reserves extra ports as create-time services beside the kernel', async () => {
			const world = makeWorld();
			await makeCompute(world, { ...baseConfig, extraPorts: [8443], kernelVisibility: 'custom' })
				.create(SANDBOX_ID)
				.exec('true');
			const opts = world.created[0];
			expect(opts.services).toEqual([
				{ name: 'kernel', port: 2718, protocol: 'tcp', visibility: 'custom' },
				{ name: 'port-8443', port: 8443, protocol: 'tcp', visibility: 'custom' },
			]);
		});

		it('reserves extra ports on the template overlay too', async () => {
			const world = makeWorld();
			await makeCompute(world, { ...baseConfig, extraPorts: [8443], templateId: 'tmpl-marimohub' })
				.create(SANDBOX_ID)
				.exec('true');
			const { options } = world.createdFromTemplate[0];
			expect(options.services?.map((s) => s.port)).toEqual([2718, 8443]);
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
		it('sends shell-quoted environment values over stdin', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.setEnvVars({ TOKEN: "a'b", DIR: '/x' });
			await inst.exec('echo hi');
			const fake = [...world.registry.values()][0].fake;
			const cmd = fake.stdinWrites.at(-1)!;
			expect(fake.runCalls.at(-1)![2]).toContain('/tmp/marimohub-env-');
			expect(JSON.stringify([...fake.runCalls, ...fake.startCalls])).not.toContain('export ');
			expect(cmd).toContain("export TOKEN='a'\\''b'; ");
			expect(cmd).toContain("export DIR='/x'; ");
			expect(fake.runCalls.at(-1)![2].endsWith('echo hi')).toBe(true);
		});

		it('merges across multiple setEnvVars calls', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.setEnvVars({ A: '1' });
			await inst.setEnvVars({ B: '2' });
			await inst.exec('run');
			const fake = [...world.registry.values()][0].fake;
			const cmd = fake.stdinWrites.at(-1)!;
			expect(fake.runCalls.at(-1)![2]).toContain('/tmp/marimohub-env-');
			expect(JSON.stringify([...fake.runCalls, ...fake.startCalls])).not.toContain('export ');
			expect(cmd).toContain("export A='1'; ");
			expect(cmd).toContain("export B='2'; ");
		});

		it('applies onlyIfUnset vars as guarded defaults after the forced exports', async () => {
			const world = makeWorld();
			const inst = makeCompute(world).create(SANDBOX_ID);
			await inst.setEnvVars({ A: '1' });
			await inst.setEnvVars({ CACHE: '/tmp/c' }, { onlyIfUnset: true });
			await inst.exec('run');
			const fake = [...world.registry.values()][0].fake;
			const cmd = fake.stdinWrites.at(-1)!;
			expect(fake.runCalls.at(-1)![2]).toContain('/tmp/marimohub-env-');
			expect(JSON.stringify([...fake.runCalls, ...fake.startCalls])).not.toContain('export ');
			expect(cmd).toBe("export A='1'; [ -n \"${CACHE+x}\" ] || export CACHE='/tmp/c'; ");
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
				runFromTemplate: async () => {
					throw new Error('unused');
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
					getStatus: async () => 'running' as const,
					commands: { run: async () => procResult(), start: async () => fakeProcess() },
					files: { readText: async () => '', write: async () => {} },
					delete: async () => {
						throw new Error('gRPC unavailable');
					},
				}),
				runFromTemplate: async () => {
					throw new Error('unused');
				},
				fromId: async (id) => ({
					sandboxId: id,
					getStatus: async () => 'running' as const,
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
			getStatus: async () => 'running' as const,
			commands: { run: async () => procResult(), start: async () => fakeProcess() },
			files: { readText: async () => '', write: async () => {} },
			delete: async () => {},
		});

		it('fails the provision when the sandbox completes during boot', async () => {
			// v1's wait() reports `completed` as a satisfied running-wait; the
			// adapter must turn that into a boot failure, not a working sandbox.
			const client: CoreWeaveClient = {
				create: async () => ({
					...bareSandbox('cw-done'),
					status: 'completed' as const,
					getStatus: async () => 'completed' as const,
				}),
				runFromTemplate: async () => {
					throw new Error('unused');
				},
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
				runFromTemplate: async () => {
					throw new Error('unused');
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
				runFromTemplate: async () => {
					throw new Error('unused');
				},
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
			{ ...baseConfig, extraPorts: [8443] },
		),
	{
		mountFallsBack: true,
		secondaryPort: 8443,
		semantics: { failingCommand: 'mh-contract-fail', launch: {} },
	},
);

describe('CoreWeaveCompute launchProcess', () => {
	it.each(['completes', 'fails', 'stalls'] as const)(
		'waits for bounded process cancellation when a launch times out and cancellation %s',
		async (cancellation) => {
			let releaseStreams!: () => void;
			const released = new Promise<void>((resolve) => {
				releaseStreams = resolve;
			});
			let streamsEnded = 0;
			async function* stalled(): AsyncGenerator<string> {
				await released;
				streamsEnded++;
				yield '';
			}
			const cancel = vi.fn(async () => {
				if (cancellation === 'stalls') return released;
				await new Promise((resolve) => setTimeout(resolve, 50));
				if (cancellation === 'fails') throw new Error('Cancellation failed');
				releaseStreams();
			});
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			const world = makeWorld({
				startImpl: async () => ({ ...fakeProcess(), stdout: stalled(), stderr: stalled(), cancel }),
			});
			const inst = makeCompute(world).create(SANDBOX_ID, { reuse: false });
			vi.useFakeTimers();
			try {
				let resolved = false;
				const pending = inst.launchProcess!('marimo edit', { port: 2718, startupTimeout: 200 });
				void pending.then(() => {
					resolved = true;
				});
				await vi.advanceTimersByTimeAsync(450);
				expect(cancel).toHaveBeenCalledOnce();
				expect(resolved).toBe(false);
				await vi.advanceTimersByTimeAsync(1_000);
				await expect(pending).resolves.toMatchObject({
					success: false,
					reason: 'readiness_timeout',
					timings: { waitport: 450 },
				});
				if (cancellation === 'completes') {
					expect(streamsEnded).toBe(2);
					expect(log).not.toHaveBeenCalled();
				} else {
					expect(log).toHaveBeenCalledWith(
						expect.stringContaining('"event":"sandbox_process_cancel_failed"'),
					);
				}
			} finally {
				releaseStreams();
				log.mockRestore();
				vi.useRealTimers();
			}
		},
	);
});

describe('CoreWeave warm sandbox reconnect', () => {
	it('exports a credential-free reference and reconnects by Get without tag discovery', async () => {
		const world = makeWorld();
		const source = makeCompute(world).create(SANDBOX_ID, { reuse: false });
		expect(source.reconnectReference).toBeUndefined();
		await source.ready!();
		const reference = source.reconnectReference;
		expect(JSON.parse(reference!)).toEqual({
			kind: 'coreweave-v1',
			hubId: SANDBOX_ID,
			sandboxId: 'cw-1',
		});
		const get = vi.spyOn(world.client, 'fromId');
		const sandbox = makeCompute(world).connectExisting(SANDBOX_ID, {
			reconnectReference: reference,
		});
		expectExecResult(await sandbox.exec('true'), { success: true });
		await sandbox.exec('true');
		expect(get).toHaveBeenCalledExactlyOnceWith('cw-1');
		expect(world.listCalls).toEqual([]);
		expect(world.created).toHaveLength(1);
		expect(sandbox.drainTimings!()).toMatchObject({ find: 0, boot: 0 });
	});

	it('keeps the legacy path for injected clients without running-status metadata', async () => {
		const world = makeWorld();
		const create = world.client.create.bind(world.client);
		vi.spyOn(world.client, 'create').mockImplementation(async (options) => ({
			...(await create(options)),
			status: undefined,
		}));
		const source = makeCompute(world).create(SANDBOX_ID, { reuse: false });
		await source.ready!();
		expect(source.reconnectReference).toBeUndefined();
		expectExecResult(await makeCompute(world).connectExisting(SANDBOX_ID).exec('true'), {
			success: true,
		});
		expect(world.listCalls).toEqual([[ID_TAG]]);
	});

	it('reports direct Get time separately from creation and discovery', async () => {
		vi.useFakeTimers();
		try {
			const world = makeWorld();
			const source = makeCompute(world).create(SANDBOX_ID, { reuse: false });
			await source.ready!();
			const get = world.client.fromId.bind(world.client);
			vi.spyOn(world.client, 'fromId').mockImplementation(async (id) => {
				vi.setSystemTime(Date.now() + 200);
				return get(id);
			});
			const sandbox = makeCompute(world).connectExisting(SANDBOX_ID, {
				reconnectReference: source.reconnectReference,
			});
			await sandbox.ready!();
			expect(sandbox.drainTimings!()).toEqual({ find: 0, create: 0, get: 200, boot: 0 });
			expect(world.listCalls).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		'pending',
		'creating',
		'paused',
		'terminating',
		'completed',
		'terminated',
		'failed',
		'unspecified',
	] as const)(
		'fails closed when a saved container is %s, without discovering or creating another',
		async (status) => {
			const world = makeWorld();
			const source = makeCompute(world).create(SANDBOX_ID, { reuse: false });
			await source.ready!();
			const reference = source.reconnectReference;
			world.registry.get('cw-1')!.fake.status = status;
			const get = vi.spyOn(world.client, 'fromId');
			const sandbox = makeCompute(world).connectExisting(SANDBOX_ID, {
				reconnectReference: reference,
			});
			await expect(sandbox.exec('true')).rejects.toThrow('no longer available');
			await expect(sandbox.exec('true')).rejects.toThrow('no longer available');
			expect(get.mock.calls).toEqual([['cw-1'], ['cw-1']]);
			expect(sandbox.reconnectReference).toBeUndefined();
			expect(world.registry.get('cw-1')!.fake.runCalls).toEqual([]);
			expect(world.listCalls).toEqual([]);
			expect(world.created).toHaveLength(1);
		},
	);

	it('does not rediscover by tag after a saved container disappears', async () => {
		const world = makeWorld();
		const source = makeCompute(world).create(SANDBOX_ID, { reuse: false });
		await source.ready!();
		const reference = source.reconnectReference;
		const get = vi
			.spyOn(world.client, 'fromId')
			.mockRejectedValue(new CWSandboxNotFoundError('not found'));
		await expect(
			makeCompute(world)
				.connectExisting(SANDBOX_ID, { reconnectReference: reference })
				.exec('true'),
		).rejects.toBeInstanceOf(CWSandboxNotFoundError);
		expect(get).toHaveBeenCalledExactlyOnceWith('cw-1');
		expect(world.listCalls).toEqual([]);
		expect(world.created).toHaveLength(1);
	});

	it('rejects a Get response for a different provider container', async () => {
		const world = makeWorld();
		const source = makeCompute(world).create(SANDBOX_ID, { reuse: false });
		await source.ready!();
		const get = world.client.fromId.bind(world.client);
		vi.spyOn(world.client, 'fromId').mockImplementation(async (id) => ({
			...(await get(id)),
			sandboxId: 'wrong-container',
		}));
		await expect(
			makeCompute(world)
				.connectExisting(SANDBOX_ID, { reconnectReference: source.reconnectReference })
				.exec('true'),
		).rejects.toThrow('no longer available');
		expect(world.registry.get('cw-1')!.fake.runCalls).toEqual([]);
		expect(world.listCalls).toEqual([]);
	});

	it('rejects a referenced handle without status metadata', async () => {
		const world = makeWorld();
		const source = makeCompute(world).create(SANDBOX_ID, { reuse: false });
		await source.ready!();
		const get = world.client.fromId.bind(world.client);
		vi.spyOn(world.client, 'fromId').mockImplementation(async (id) => ({
			...(await get(id)),
			status: undefined,
		}));
		const sandbox = makeCompute(world).connectExisting(SANDBOX_ID, {
			reconnectReference: source.reconnectReference,
		});
		await expect(sandbox.exec('true')).rejects.toThrow('no longer available');
		expect(sandbox.reconnectReference).toBeUndefined();
		expect(world.registry.get('cw-1')!.fake.runCalls).toEqual([]);
		expect(world.listCalls).toEqual([]);
		expect(world.created).toHaveLength(1);
	});

	it('retries a failed Get by the same reference without discovery or creation', async () => {
		const world = makeWorld();
		const source = makeCompute(world).create(SANDBOX_ID, { reuse: false });
		await source.ready!();
		const error = new CWSandboxUnavailableError('gateway unavailable');
		const get = vi.spyOn(world.client, 'fromId').mockRejectedValueOnce(error);
		const sandbox = makeCompute(world).connectExisting(SANDBOX_ID, {
			reconnectReference: source.reconnectReference,
		});
		await expect(sandbox.exec('true')).rejects.toBe(error);
		expect(sandbox.reconnectReference).toBeUndefined();
		expect(world.registry.get('cw-1')!.fake.runCalls).toEqual([]);
		expectExecResult(await sandbox.exec('true'), { success: true });
		expect(get.mock.calls).toEqual([['cw-1'], ['cw-1']]);
		expect(world.listCalls).toEqual([]);
		expect(world.created).toHaveLength(1);
	});

	it.each([
		'not-json',
		'',
		'null',
		'[]',
		'"reference"',
		'42',
		'{}',
		JSON.stringify({ kind: 'coreweave-v1', hubId: SANDBOX_ID }),
		JSON.stringify({ kind: 'coreweave-v1', hubId: SANDBOX_ID, sandboxId: 1 }),
		JSON.stringify({ kind: 'coreweave-v1', hubId: SANDBOX_ID, sandboxId: 'x'.repeat(257) }),
		JSON.stringify({ kind: 'coreweave-v1', hubId: SANDBOX_ID, sandboxId: 'cw-1' }).padEnd(4097),
		JSON.stringify({ kind: 'coreweave-v2', hubId: SANDBOX_ID, sandboxId: 'cw-1' }),
		JSON.stringify({ kind: 'coreweave-v1', hubId: 'different-hub-id', sandboxId: 'cw-1' }),
		JSON.stringify({ kind: 'coreweave-v1', hubId: SANDBOX_ID, sandboxId: '' }),
		JSON.stringify({
			kind: 'coreweave-v1',
			hubId: SANDBOX_ID,
			sandboxId: 'cw-1',
			token: 'private-value',
		}),
	])(
		'rejects invalid or mismatched references without network operations (%#)',
		async (reference) => {
			const world = makeWorld();
			const get = vi.spyOn(world.client, 'fromId');
			const sandbox = makeCompute(world).connectExisting(SANDBOX_ID, {
				reconnectReference: reference,
			});
			await expect(sandbox.ready!()).rejects.toBeInstanceOf(CWSandboxConfigurationError);
			await expect(sandbox.exec('true')).rejects.toBeInstanceOf(CWSandboxConfigurationError);
			await expect(sandbox.destroy()).rejects.toBeInstanceOf(CWSandboxConfigurationError);
			expect(sandbox.reconnectReference).toBeUndefined();
			expect(get).not.toHaveBeenCalled();
			expect(world.deleted).toEqual([]);
			expect(world.listCalls).toEqual([]);
			expect(world.created).toEqual([]);
		},
	);

	it('accepts the reference and provider ID length limits', async () => {
		const world = makeWorld();
		const sandboxId = 'x'.repeat(256);
		const reference = JSON.stringify({ kind: 'coreweave-v1', hubId: SANDBOX_ID, sandboxId }).padEnd(
			4096,
		);
		const error = new CWSandboxNotFoundError('not found');
		const get = vi.spyOn(world.client, 'fromId').mockRejectedValue(error);
		const sandbox = makeCompute(world).connectExisting(SANDBOX_ID, {
			reconnectReference: reference,
		});
		await expect(sandbox.ready!()).rejects.toBe(error);
		expect(get).toHaveBeenCalledExactlyOnceWith(sandboxId);
		expect(world.listCalls).toEqual([]);
		expect(world.created).toEqual([]);
	});

	it('tolerates a missing referenced container on deletion but propagates other errors', async () => {
		const world = makeWorld();
		const source = makeCompute(world).create(SANDBOX_ID, { reuse: false });
		await source.ready!();
		const sandbox = makeCompute(world).connectExisting(SANDBOX_ID, {
			reconnectReference: source.reconnectReference,
		});
		const error = new CWSandboxUnavailableError('gateway unavailable');
		const remove = vi
			.spyOn(world.client, 'delete')
			.mockRejectedValueOnce(error)
			.mockRejectedValueOnce(new CWSandboxNotFoundError('not found'));
		await expect(sandbox.destroy()).rejects.toBe(error);
		await expect(sandbox.destroy()).resolves.toBeUndefined();
		expect(remove.mock.calls).toEqual([['cw-1'], ['cw-1']]);
		expect(world.listCalls).toEqual([]);
		expect(world.created).toHaveLength(1);
	});

	it('destroys a saved container by its exact ID without discovery or recreation', async () => {
		const world = makeWorld();
		const source = makeCompute(world).create(SANDBOX_ID, { reuse: false });
		await source.ready!();
		const sandbox = makeCompute(world).connectExisting(SANDBOX_ID, {
			reconnectReference: source.reconnectReference,
		});
		const get = vi.spyOn(world.client, 'fromId');
		await sandbox.destroy();
		await sandbox.destroy();
		expect(get).not.toHaveBeenCalled();
		expect(world.listCalls).toEqual([]);
		expect(world.created).toHaveLength(1);
		expect(world.deleted).toEqual(['cw-1', 'cw-1']);
	});

	it('reconnects from another provider without creating a sandbox', async () => {
		const world = makeWorld();
		await makeCompute(world).create(SANDBOX_ID, { reuse: false }).exec('true');
		expectExecResult(await makeCompute(world).connectExisting(SANDBOX_ID).exec('true'), {
			success: true,
		});
		expect(world.created).toHaveLength(1);
	});

	it('fails without creating when the sandbox is absent or deleted', async () => {
		const world = makeWorld();
		await expect(makeCompute(world).connectExisting(SANDBOX_ID).ready!()).rejects.toThrow(
			'no longer available',
		);
		expect(world.created).toHaveLength(0);
		await makeCompute(world).create(SANDBOX_ID).exec('true');
		await makeCompute(world).create(SANDBOX_ID).destroy();
		await expect(makeCompute(world).connectExisting(SANDBOX_ID).exec('true')).rejects.toThrow(
			'no longer available',
		);
		expect(world.created).toHaveLength(1);
	});
});

describe('bounded file transport', () => {
	it('cancels the process when streamed output exceeds the limit', async () => {
		const cancel = vi.fn(async () => {});
		const world = makeWorld({
			startImpl: async () => ({
				...fakeProcess({ exitCode: 0 }),
				stdout: (async function* () {
					yield 'x'.repeat(2049);
				})(),
				cancel,
			}),
		});
		expect(
			(
				await makeCompute(world).create(SANDBOX_ID).readFileBounded!('/workspace/file', {
					maxBytes: 2,
					timeoutMs: 100,
				})
			).success,
		).toBe(false);
		expect(cancel).toHaveBeenCalledOnce();
	});
});
