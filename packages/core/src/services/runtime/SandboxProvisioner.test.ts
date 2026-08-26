import { describe, it, expect, vi } from 'vitest';
import { Millis } from '../../duration';
import { createNotebookId, createProjectId, createSandboxId, createVersionId } from '../../ids';
import { paths } from '../../paths';
import {
	ACTOR,
	EXPOSED_URL,
	fakeComputeFrom,
	makeFakeSandbox,
	makeFsSandbox,
	makeLocalSource,
	MemoryBucket,
	setupTestEnv,
} from '../../testing';
import type { FilesystemSnapshots, SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { NotebookService } from '../content/NotebookService';
import { SandboxProvisioner } from './SandboxProvisioner';
import type { BucketConfig, WorkspaceLoadStrategies } from './SandboxProvisioner';

const MOUNT_PATH = '/workspace';

const bucketConfig: BucketConfig = {
	name: 'test-bucket',
	endpoint: 'https://r2.example',
};

/**
 * A fake provider that ALSO implements the optional `FilesystemSnapshots`
 * capability, recording restore-creates, captures, and snapshot deletes so the
 * snapshot-on-teardown / restore-on-provision paths can be asserted.
 */
function makeSnapshotCompute(
	instance: SandboxInstance,
	opts: { captureId?: string; failCapture?: boolean } = {},
): SandboxProvider &
	FilesystemSnapshots & {
		createdFrom: { id: string; snapshotId: string }[];
		deleted: string[];
	} {
	const createdFrom: { id: string; snapshotId: string }[] = [];
	const deleted: string[] = [];
	return {
		filesystemSnapshotsEnabled: true,
		create: () => instance,
		proxy: async () => null,
		createFromSnapshot(id, snapshotId) {
			createdFrom.push({ id, snapshotId });
			return instance;
		},
		async captureSnapshot() {
			if (opts.failCapture) throw new Error('snapshot api down');
			return { snapshotId: opts.captureId ?? 'snap_new', sizeBytes: 123 };
		},
		async deleteSnapshot(snapshotId) {
			deleted.push(snapshotId);
		},
		createdFrom,
		deleted,
	};
}

describe('SandboxProvisioner', () => {
	const projectId = createProjectId();
	const notebookId = createNotebookId();
	const sandboxId = createSandboxId();

	describe('provision', () => {
		it('happy path with mount: usedFallback false, returns exposed url, starts marimo on port 2718', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			const result = await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
			});

			expect(result.usedFallback).toBe(false);
			expect(result.url).toBe(EXPOSED_URL);
			expect(result.sandbox).toBe(instance);
			expect(result.timings.total).toEqual(expect.any(Number));

			expect(calls.exec).toContain('true');
			// Bucket was mounted (no fallback file copy).
			expect(calls.mountBucket).toHaveLength(1);
			expect(calls.mountBucket[0].mountPath).toBe(MOUNT_PATH);
			expect(calls.writeFile).toHaveLength(0);

			expect(calls.startProcess).toHaveLength(1);
			expect(calls.startProcess[0].options?.cwd).toBe(MOUNT_PATH);
			expect(calls.startProcess[0].cmd).toContain('marimo edit');
			expect(calls.startProcess[0].cmd).toContain('2718');
			expect(calls.waitForPort).toEqual([2718]);
			expect(calls.exposePort[0].port).toBe(2718);
			expect(calls.exposePort[0].options.token).toBe(sandboxId);

			// No asset-url arg unless configured.
			expect(calls.startProcess[0].cmd).not.toContain('--asset-url');
			// Binds all interfaces so the external ingress can reach the kernel.
			expect(calls.startProcess[0].cmd).toContain('--host 0.0.0.0');
		});

		it('runs resolved launch setup before starting the kernel', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				entryNotebook: 'apps/dash.py',
				launchStrategy: 'uv-script-pins',
			});

			// Notebook pins apply last, except marimo remains at the image version.
			const cmd = calls.exec.find((command) => command.includes('uv sync --inexact'))!;
			const order = [
				cmd.indexOf('uv sync --inexact'),
				cmd.indexOf('marimo==$MARIMOHUB_MARIMO_VERSION'),
				cmd.indexOf("uv export --script 'apps/dash.py'"),
				cmd.lastIndexOf('uv pip install'),
			];
			expect(Math.min(...order)).toBeGreaterThanOrEqual(0);
			expect(order).toEqual([...order].sort((a, b) => a - b));
			expect(cmd).toContain('--prune marimo');
			expect(calls.startProcess[0].cmd).toContain("marimo edit 'apps/dash.py'");
			expect(calls.startProcess[0].cmd).not.toContain('uv sync');
		});

		it('defaults to the project-managed env when no launch strategy is given', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
			});

			const cmd = calls.exec.find((command) => command.includes('uv sync --inexact'))!;
			expect(cmd).toContain('uv sync --inexact');
			expect(cmd).not.toContain('uv export');
			expect(cmd).not.toContain('marimohub-script-requirements.txt');
		});

		it('accepts sessionEnv as a promise, injecting it once resolved', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				sessionEnv: Promise.resolve({
					vars: { A: '1' },
					files: [{ path: '/creds', content: 'hi' }],
				}),
			});

			expect(calls.writeFile).toContainEqual({ path: '/creds', content: 'hi' });
			expect(calls.setEnvVars).toContainEqual({ A: '1' });
		});

		it('forwards the resolved base image to provider.create', async () => {
			const { instance } = makeFakeSandbox();
			const compute = fakeComputeFrom(instance);
			const provisioner = new SandboxProvisioner(compute);

			await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				image: 'ghcr.io/marimo/custom:1',
			});

			expect(compute.lastCreateOptions).toEqual({ reuse: false, image: 'ghcr.io/marimo/custom:1' });
		});

		it('forwards a user home to sandbox creation', async () => {
			const { instance } = makeFakeSandbox();
			const compute = fakeComputeFrom(instance);
			const provisioner = new SandboxProvisioner(compute);
			const userHome = { key: 'ada@example.com', path: '/mnt/ada@example.com' };

			await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				userHome,
			});

			expect(compute.lastCreateOptions).toEqual({ reuse: false, userHome });
		});

		it('destroys the sandbox when a sessionEnv promise rejects (fail-closed creds)', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await expect(
				provisioner.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					sessionEnv: Promise.reject(new Error('secret_resolution_failed')),
				}),
			).rejects.toThrow('secret_resolution_failed');

			expect(calls.destroy).toBe(1);
		});

		it('merges adapter-drained timings onto the result as reachable_*', async () => {
			const { instance } = makeFakeSandbox();
			// Simulate CoreWeave surfacing its lazy create/find split (hidden in `reachable`).
			instance.drainTimings = () => ({ create: 42, find: 7 });
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			const result = await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
			});

			expect(result.timings.reachable_create).toBe(42);
			expect(result.timings.reachable_find).toBe(7);
		});

		it('passes --asset-url when assetUrl is set', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const assetUrl = 'https://cdn.jsdelivr.net/npm/@marimo-team/frontend@{version}/dist';

			await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				assetUrl,
			});

			expect(calls.startProcess[0].cmd).toContain(`--asset-url="${assetUrl}"`);
		});

		it('gives the remaining startup timeout to the kernel port wait', async () => {
			const defaulted = makeFakeSandbox();
			await new SandboxProvisioner(fakeComputeFrom(defaulted.instance)).provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
			});
			expect(defaulted.calls.waitForPortOptions).toHaveLength(1);
			const defaultTimeout = defaulted.calls.waitForPortOptions[0]!.timeout;
			expect(defaultTimeout).toBeGreaterThan(119_000);
			expect(defaultTimeout).toBeLessThanOrEqual(120_000);

			vi.useFakeTimers();
			try {
				const configured = makeFakeSandbox();
				const exec = configured.instance.exec.bind(configured.instance);
				configured.instance.exec = async (command, options) => {
					const result = await exec(command, options);
					if (command.includes('uv sync --inexact')) {
						await new Promise((resolve) => setTimeout(resolve, 30_000));
					}
					return result;
				};

				const provision = new SandboxProvisioner(fakeComputeFrom(configured.instance)).provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					startupTimeoutMs: Millis.seconds(300),
				});
				await vi.advanceTimersByTimeAsync(30_000);
				await provision;

				const setupIndex = configured.calls.exec.findIndex((command) =>
					command.includes('uv sync --inexact'),
				);
				expect(setupIndex).toBeGreaterThanOrEqual(0);
				expect(configured.calls.execOptions[setupIndex]?.timeout).toBe(300_000);
				expect(configured.calls.waitForPortOptions).toEqual([{ timeout: 270_000 }]);
			} finally {
				vi.useRealTimers();
			}
		});

		it('names the startup timeout (and the config var) when the port wait consumes the full window', async () => {
			const { instance } = makeFakeSandbox({
				failWaitForPort: new Error('timed out after 0ms'),
				logs: { stdout: 'Resolved 42 packages', stderr: '' },
			});
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			// A 0ms window means the (instant) rejection has already consumed it, so
			// the deadline classification triggers without waiting out a real timeout.
			await expect(
				provisioner.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					startupTimeoutMs: Millis.of(0),
				}),
			).rejects.toThrow(
				/not ready within the 0s startup timeout \(MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS\)[\s\S]*Resolved 42 packages/,
			);
		});

		it('classifies on the attribution line only — appended output echoing "before port" stays a timeout', async () => {
			const { instance } = makeFakeSandbox({
				// An adapter timeout error whose appended process-output tail happens
				// to contain the crash phrase.
				failWaitForPort: new Error(
					'timed out waiting for port 2718 after 0ms.\n' +
						'earlier attempt: process exited (code 1) before port 2718 was ready.',
				),
			});
			await expect(
				new SandboxProvisioner(fakeComputeFrom(instance)).provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					startupTimeoutMs: Millis.of(0),
				}),
			).rejects.toThrow(/startup timeout \(MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS\)/);
		});

		it('reads an adapter-attributed crash as a crash even at the deadline', async () => {
			const { instance } = makeFakeSandbox({
				failWaitForPort: new Error('process exited (code 1) before port 2718 was ready.'),
				logs: { stdout: '', stderr: 'boom' },
			});
			const failure = await new SandboxProvisioner(fakeComputeFrom(instance))
				.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					// 0ms: the whole window is consumed, so only the adapter's "before
					// port" attribution keeps this from reading as a timeout.
					startupTimeoutMs: Millis.of(0),
				})
				.catch((err: Error) => err);
			expect((failure as Error).message).not.toContain('startup timeout');
			expect((failure as Error).message).toContain('boom');
		});

		it('keeps a pre-deadline kernel crash distinct from a startup timeout', async () => {
			const { instance } = makeFakeSandbox({
				failWaitForPort: new Error('process exited before the port opened'),
				logs: { stdout: '', stderr: 'ModuleNotFoundError: no module named marimo' },
			});
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			const failure = await provisioner
				.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				})
				.catch((err: Error) => err);
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toContain('starting the marimo kernel');
			expect((failure as Error).message).toContain('ModuleNotFoundError');
			expect((failure as Error).message).not.toContain('startup timeout');
		});

		it('injects sessionEnv (files + env) BEFORE starting the kernel', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				sessionEnv: {
					vars: { AWS_ACCESS_KEY_ID: 'CWAK', AWS_ENDPOINT_URL_S3: 'https://cwobject.com' },
					files: [{ path: '/var/run/marimohub/wif-token', content: 'eyJ.jwt.sig' }],
				},
			});

			expect(calls.setEnvVars).toEqual([
				{ AWS_ACCESS_KEY_ID: 'CWAK', AWS_ENDPOINT_URL_S3: 'https://cwobject.com' },
			]);
			expect(calls.writeFile).toEqual([
				{ path: '/var/run/marimohub/wif-token', content: 'eyJ.jwt.sig' },
			]);
			// Env + token file must land before the kernel process starts.
			expect(calls.sequence).toEqual(['writeFiles', 'setEnvVars', 'startProcess']);
		});

		it('injects sessionEnv defaults with onlyIfUnset, before the kernel starts', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				sessionEnv: { defaults: { XDG_CACHE_HOME: '/tmp/marimohub-cache' } },
			});

			expect(calls.setEnvDefaults).toEqual([{ XDG_CACHE_HOME: '/tmp/marimohub-cache' }]);
			expect(calls.setEnvVars).toHaveLength(0);
			expect(calls.sequence).toEqual(['setEnvDefaults', 'startProcess']);
		});

		it('skips the env calls when sessionEnv holds only empty objects', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				sessionEnv: { vars: {}, defaults: {}, files: [] },
			});

			expect(calls.setEnvVars).toHaveLength(0);
			expect(calls.setEnvDefaults).toHaveLength(0);
			expect(calls.sequence).toEqual(['startProcess']);
		});

		it('does not call setEnvVars/writeFile when sessionEnv is omitted', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
			});

			expect(calls.setEnvVars).toHaveLength(0);
			expect(calls.writeFile).toHaveLength(0);
			expect(calls.sequence).toEqual(['startProcess']);
		});

		it('fallback path: mountBucket throws -> usedFallback true, restoreWorkspace copies the workspace in', async () => {
			const { instance, calls } = makeFakeSandbox({ failMount: true });
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			// Seed the bucket handle so the fallback copy has a workspace to restore.
			const bucketHandle = new MemoryBucket();
			const nb = paths.project(projectId).notebook(notebookId);
			await bucketHandle.put(nb.code, 'import marimo as mo');
			await bucketHandle.put(nb.deps, '[project]\nname = "nb"');

			const result = await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				bucketHandle,
			});

			expect(result.usedFallback).toBe(true);
			expect(result.url).toBe(EXPOSED_URL);

			// Fallback restored both workspace files into the mount path, in one batched
			// write of raw bytes (no per-file base64/temp-file dance).
			const restored = calls.writeFiles.flat().map((f) => f.path);
			expect(restored).toContain(`${MOUNT_PATH}/notebook.py`);
			expect(restored).toContain(`${MOUNT_PATH}/pyproject.toml`);
			// marimo still started after the fallback copy.
			expect(calls.startProcess).toHaveLength(1);
		});

		it('never attempts the mount when the backend advertises supportsBucketMount: false', async () => {
			const { instance: base, calls } = makeFakeSandbox({ failMount: true });
			const instance = { ...base, supportsBucketMount: false };
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			const bucketHandle = new MemoryBucket();
			const nb = paths.project(projectId).notebook(notebookId);
			await bucketHandle.put(nb.code, 'import marimo as mo');
			await bucketHandle.put(nb.deps, '[project]\nname = "nb"');

			const result = await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				bucketHandle,
			});

			expect(result.usedFallback).toBe(true);
			expect(calls.mountBucket).toHaveLength(0);
		});

		it('does not hide a mount failure when the backend advertises mount support', async () => {
			const { instance: base, calls } = makeFakeSandbox({ failMount: true });
			const instance = { ...base, supportsBucketMount: true };
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await expect(
				provisioner.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					bucketHandle: new MemoryBucket(),
				}),
			).rejects.toThrow('Failed to start sandbox while mounting the notebook workspace');
			expect(calls.mountBucket).toHaveLength(1);
			expect(calls.writeFiles).toHaveLength(0);
			expect(calls.startProcess).toHaveLength(0);
		});

		// A command round-trip is the dominant unit of startup cost on a remote
		// backend (~220ms each on CoreWeave), so these lock in the count.
		describe('command round-trips', () => {
			it('prefers combined launch and keeps its phase timings', async () => {
				const { instance, calls } = makeFakeSandbox();
				instance.ready = async () => {};
				instance.launchProcess = async (command, options) => ({
					success: true,
					process: await instance.startProcess(command, { cwd: options.cwd }),
					timings: { setup: 41, start: 3, waitport: 17 },
				});

				const result = await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				});

				expect(calls.exec).toHaveLength(0);
				expect(calls.startProcess).toHaveLength(1);
				expect(result.timings).toMatchObject({ setup: 41, start: 3, waitport: 17 });
			});

			it('a copy-path provision spends one checked setup exec', async () => {
				const { instance, calls } = makeFakeSandbox({ failMount: true });
				const bucketHandle = new MemoryBucket();
				const nb = paths.project(projectId).notebook(notebookId);
				await bucketHandle.put(nb.code, 'import marimo as mo');
				await bucketHandle.put(nb.workspaceFile('data/cars.csv'), 'a,b\n1,2\n');
				// `ready()` stands in for an adapter that resolves lazily (CoreWeave).
				instance.ready = async () => {};

				await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					bucketHandle,
				});

				// writeFiles creates parents and ready() replaces the reachability exec.
				expect(calls.exec).toHaveLength(1);
				expect(calls.exec[0]).toContain('uv sync');
				expect(calls.startProcess).toHaveLength(1);
			});

			it('prefers ready() over a no-op exec, and falls back when absent', async () => {
				const withReady = makeFakeSandbox();
				let readied = 0;
				withReady.instance.ready = async () => {
					readied++;
				};
				await new SandboxProvisioner(fakeComputeFrom(withReady.instance)).provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				});
				expect(readied).toBe(1);
				expect(withReady.calls.exec).not.toContain('true');

				const withoutReady = makeFakeSandbox();
				await new SandboxProvisioner(fakeComputeFrom(withoutReady.instance)).provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				});
				expect(withoutReady.calls.exec).toContain('true');
			});

			it('checks launch setup before starting the kernel process', async () => {
				const { instance, calls } = makeFakeSandbox();
				instance.ready = async () => {};
				const exec = instance.exec.bind(instance);
				const startProcess = instance.startProcess.bind(instance);
				let setupComplete = false;
				instance.exec = async (command, options) => {
					const result = await exec(command, options);
					if (command.includes('uv sync')) setupComplete = true;
					return result;
				};
				instance.startProcess = async (command, options) => {
					expect(setupComplete).toBe(true);
					return startProcess(command, options);
				};

				await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				});

				expect(calls.exec).toHaveLength(1);
				expect(calls.exec[0]).toContain('uv sync');
				expect(calls.startProcess[0].cmd).toContain('marimo edit');
				expect(calls.startProcess[0].cmd).not.toContain('uv sync');
			});
		});

		it('reports a checked setup failure without starting the kernel', async () => {
			const { instance: base, calls } = makeFakeSandbox();
			const instance: SandboxInstance = {
				...base,
				async exec(command) {
					if (!command.includes('uv sync')) return base.exec(command);
					calls.exec.push(command);
					return {
						success: false,
						stdout: '',
						stderr: 'failed to remove directory: Permission denied',
						error: { code: 'COMMAND_FAILED' },
					};
				},
			};

			const failure = await new SandboxProvisioner(fakeComputeFrom(instance))
				.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				})
				.catch((error: unknown) => error);

			expect(failure).toMatchObject({
				name: 'PythonEnvironmentSetupError',
				code: 'PYTHON_ENV_SETUP_FAILED',
				status: 503,
			});

			expect((failure as Error).message).toContain('does not allow replacing');
			expect(calls.startProcess).toHaveLength(0);
			expect(calls.destroy).toBe(1);
		});

		it.each([
			[
				'a malformed pyproject',
				'tomllib.TOMLDecodeError: Invalid value (at end of document)',
				'pyproject.toml could not be parsed',
			],
			[
				'a missing TOML parser',
				"ModuleNotFoundError: No module named 'tomllib'",
				'sandbox Python does not include the tomllib parser',
			],
		])('classifies %s as a checked setup failure', async (_case, stderr, expectedMessage) => {
			const { instance: base, calls } = makeFakeSandbox();
			const instance: SandboxInstance = {
				...base,
				async exec(command) {
					if (!command.includes('uv sync')) return base.exec(command);
					calls.exec.push(command);
					return {
						success: false,
						stdout: '',
						stderr,
						error: { code: 'COMMAND_FAILED' },
					};
				},
			};

			const failure = await new SandboxProvisioner(fakeComputeFrom(instance))
				.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				})
				.catch((error: unknown) => error);

			expect(failure).toMatchObject({ code: 'PYTHON_ENV_SETUP_FAILED', status: 503 });
			expect((failure as Error).message).toContain(expectedMessage);
			expect(calls.startProcess).toHaveLength(0);
			expect(calls.destroy).toBe(1);
		});

		it('mount failure without a bucket handle rejects instead of starting an empty workspace', async () => {
			const { instance, calls } = makeFakeSandbox({ failMount: true });
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await expect(
				provisioner.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				}),
			).rejects.toThrow(/mounting the notebook workspace/i);

			expect(calls.startProcess).toHaveLength(0);
			expect(calls.destroy).toBe(1);
		});

		it('copy-only mode skips mount and launches the configured entry notebook', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const bucketHandle = new MemoryBucket();
			const nb = paths.project(projectId).notebook(notebookId);
			await bucketHandle.put(nb.workspaceFile('apps/my_app.py'), 'import marimo as mo');

			const result = await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				bucketHandle,
				entryNotebook: 'apps/my_app.py',
				workspaceLoadMode: 'copy-only',
			});

			expect(result.usedFallback).toBe(true);
			expect(calls.mountBucket).toHaveLength(0);
			expect(calls.writeFiles.flat().some((f) => f.path.endsWith('apps/my_app.py'))).toBe(true);
			expect(calls.startProcess[0].cmd).toContain("marimo edit 'apps/my_app.py'");
		});

		it('restores a packed synced workspace without listing or fetching individual files', async () => {
			const { instance, calls } = makeFakeSandbox();
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			const archive = new Uint8Array([80, 75, 3, 4]);
			await bucketHandle.put(version.workspaceArchive, archive);
			await bucketHandle.put(version.workspaceFile('app.py'), 'canonical');
			await bucketHandle.put(version.gitFile('HEAD'), 'ref: refs/heads/main\n');
			const list = vi.spyOn(bucketHandle, 'list');
			const get = vi.spyOn(bucketHandle, 'get');

			const result = await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				bucketHandle,
				workspaceLoadMode: 'copy-only',
				workspacePrefix: version.workspacePrefix,
				gitPrefix: version.gitPrefix,
				workspaceArchive: version.workspaceArchive,
			});

			expect(list).not.toHaveBeenCalled();
			expect(get).toHaveBeenCalledTimes(1);
			expect(get).toHaveBeenCalledWith(version.workspaceArchive);
			expect(calls.writeFiles).toHaveLength(1);
			expect(calls.writeFiles[0]).toHaveLength(2);
			expect(
				calls.writeFiles[0].every(({ path }) =>
					path.startsWith(`${MOUNT_PATH}/.marimohub-packed-restore/`),
				),
			).toBe(true);
			expect(calls.writeFile.some((file) => file.path.endsWith('app.py'))).toBe(false);
			expect(calls.exec.some((command) => command.startsWith('python3 '))).toBe(true);
			expect(calls.exec.find((command) => command.startsWith('python3 '))).toMatch(/ 1$/);
			expect(result.counters).toMatchObject({
				files_objects: 1,
				files_bytes: archive.byteLength,
				files_archive_used: 1,
				files_archive_missing: 0,
				files_archive_failed: 0,
				files_archive_bytes: archive.byteLength,
			});
		});

		it('does not bypass the mount strategy when an archive is passed outside copy-only mode', async () => {
			const { instance, calls } = makeFakeSandbox();
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			await bucketHandle.put(version.workspaceArchive, new Uint8Array([80, 75, 3, 4]));
			const get = vi.spyOn(bucketHandle, 'get');

			await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				bucketHandle,
				workspaceArchive: version.workspaceArchive,
			});

			expect(get).not.toHaveBeenCalledWith(version.workspaceArchive);
			expect(calls.mountBucket).toHaveLength(1);
			expect(calls.exec.some((command) => command.startsWith('python3 '))).toBe(false);
		});

		it('falls back to canonical objects when the packed workspace is absent', async () => {
			const { instance, calls } = makeFakeSandbox();
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			await bucketHandle.put(version.workspaceFile('app.py'), 'canonical');

			const result = await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				bucketHandle,
				workspaceLoadMode: 'copy-only',
				workspacePrefix: version.workspacePrefix,
				workspaceArchive: version.workspaceArchive,
			});

			expect(calls.writeFile).toContainEqual({
				path: `${MOUNT_PATH}/app.py`,
				content: expect.anything(),
			});
			expect(result.counters).toMatchObject({
				files_archive_used: 0,
				files_archive_missing: 1,
				files_archive_failed: 0,
			});
		});

		it('cleans up and falls back when packed extraction fails', async () => {
			const { instance, calls } = makeFakeSandbox();
			const exec = instance.exec.bind(instance);
			instance.exec = async (command, options) => {
				const result = await exec(command, options);
				return command.startsWith('python3 ')
					? {
							success: false,
							stdout: '',
							stderr: 'invalid archive',
							error: { code: 'COMMAND_FAILED' },
						}
					: result;
			};
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			await bucketHandle.put(version.workspaceArchive, new Uint8Array([1, 2, 3]));
			await bucketHandle.put(version.workspaceFile('app.py'), 'canonical');
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});

			try {
				const result = await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					bucketHandle,
					workspaceLoadMode: 'copy-only',
					workspacePrefix: version.workspacePrefix,
					workspaceArchive: version.workspaceArchive,
				});

				expect(calls.exec.some((command) => command.startsWith('rm -rf -- '))).toBe(true);
				expect(calls.writeFile).toContainEqual({
					path: `${MOUNT_PATH}/app.py`,
					content: expect.anything(),
				});
				expect(result.counters).toMatchObject({
					files_archive_used: 0,
					files_archive_missing: 0,
					files_archive_failed: 1,
				});
			} finally {
				log.mockRestore();
			}
		});

		it('falls back to canonical objects when fetching the packed archive fails', async () => {
			const { instance, calls } = makeFakeSandbox();
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			await bucketHandle.put(version.workspaceFile('app.py'), 'canonical');
			const realGet = bucketHandle.get.bind(bucketHandle);
			vi.spyOn(bucketHandle, 'get').mockImplementation((key) => {
				if (key === version.workspaceArchive) throw new Error('archive read unavailable');
				return realGet(key);
			});
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});

			try {
				const result = await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					bucketHandle,
					workspaceLoadMode: 'copy-only',
					workspacePrefix: version.workspacePrefix,
					workspaceArchive: version.workspaceArchive,
				});

				expect(calls.writeFile).toContainEqual({
					path: `${MOUNT_PATH}/app.py`,
					content: expect.anything(),
				});
				expect(result.counters).toMatchObject({
					files_archive_used: 0,
					files_archive_missing: 0,
					files_archive_failed: 1,
				});
			} finally {
				log.mockRestore();
			}
		});

		it('classifies a combined-launch setup failure the same way', async () => {
			const { instance, calls } = makeFakeSandbox();
			instance.launchProcess = async () => ({
				success: false,
				reason: 'setup_exit',
				exitCode: 2,
				stdout: '',
				stderr: 'TOMLDecodeError: Invalid value',
				timings: { setup: 7, start: 2, waitport: 0 },
			});

			const failure = await new SandboxProvisioner(fakeComputeFrom(instance))
				.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				})
				.catch((error: unknown) => error);

			expect(failure).toMatchObject({ code: 'PYTHON_ENV_SETUP_FAILED', status: 503 });
			expect((failure as Error).message).toContain('pyproject.toml could not be parsed');
			expect(calls.destroy).toBe(1);
		});

		it('restores pull-source Git metadata into the workspace .git directory', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			await bucketHandle.put(version.workspaceFile('app.py'), 'import marimo as mo');
			await bucketHandle.put(version.gitFile('HEAD'), 'ref: refs/heads/main\n');
			await bucketHandle.put(version.gitFile('objects/pack/pack-a.pack'), 'pack');

			const result = await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				bucketHandle,
				entryNotebook: 'app.py',
				workspaceLoadMode: 'copy-only',
				workspacePrefix: version.workspacePrefix,
				gitPrefix: version.gitPrefix,
			});

			const restored = calls.writeFiles.flat().map((file) => file.path);
			expect(restored).toContain(`${MOUNT_PATH}/app.py`);
			expect(restored).toContain(`${MOUNT_PATH}/.git/HEAD`);
			expect(restored).toContain(`${MOUNT_PATH}/.git/objects/pack/pack-a.pack`);
			expect(result.counters).toMatchObject({ files_objects: 3 });
		});

		it('preserves Git metadata stored in an ordinary copied workspace', async () => {
			const { instance, calls } = makeFakeSandbox();
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			await bucketHandle.put(version.workspaceFile('app.py'), 'import marimo as mo');
			await bucketHandle.put(version.workspaceFile('.git/HEAD'), 'ref: refs/heads/main\n');

			await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				bucketHandle,
				workspaceLoadMode: 'copy-only',
				workspacePrefix: version.workspacePrefix,
			});

			expect(calls.writeFiles.flat().map((file) => file.path)).toEqual(
				expect.arrayContaining([`${MOUNT_PATH}/app.py`, `${MOUNT_PATH}/.git/HEAD`]),
			);
		});

		it('restores copied workspace and Git metadata concurrently', async () => {
			const { instance: base, calls } = makeFakeSandbox();
			const writeFiles = base.writeFiles.bind(base);
			let inFlight = 0;
			let maxInFlight = 0;
			const instance: SandboxInstance = {
				...base,
				supportsBucketMount: false,
				async writeFiles(files) {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await new Promise((resolve) => setTimeout(resolve, 20));
					await writeFiles(files);
					inFlight--;
				},
			};
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			await bucketHandle.put(version.workspaceFile('app.py'), 'import marimo as mo');
			await bucketHandle.put(version.workspaceFile('.git/config'), 'stale');
			await bucketHandle.put(version.gitFile('HEAD'), 'ref: refs/heads/main\n');

			await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				bucketHandle,
				workspacePrefix: version.workspacePrefix,
				gitPrefix: version.gitPrefix,
			});

			expect(maxInFlight).toBe(2);
			expect(calls.writeFiles.flat().map((file) => file.path)).toEqual(
				expect.arrayContaining([`${MOUNT_PATH}/app.py`, `${MOUNT_PATH}/.git/HEAD`]),
			);
			expect(calls.writeFiles.flat().map((file) => file.path)).not.toContain(
				`${MOUNT_PATH}/.git/config`,
			);
		});

		it('restores Git metadata after a successful workspace mount', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			await bucketHandle.put(version.gitFile('HEAD'), 'ref: refs/heads/main\n');

			const result = await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				bucketHandle,
				entryNotebook: 'app.py',
				workspacePrefix: version.workspacePrefix,
				gitPrefix: version.gitPrefix,
			});

			expect(result.usedFallback).toBe(false);
			expect(calls.mountBucket).toHaveLength(1);
			expect(calls.writeFiles.flat().map((file) => file.path)).toEqual([`${MOUNT_PATH}/.git/HEAD`]);
			expect(result.counters).toMatchObject({ files_objects: 1 });
		});

		it('fails provisioning when a later Git metadata batch cannot be restored', async () => {
			const { instance, calls } = makeFakeSandbox();
			const writeFiles = instance.writeFiles.bind(instance);
			let gitWriteAttempts = 0;
			const failingInstance: SandboxInstance = {
				...instance,
				async writeFiles(files) {
					await writeFiles(files);
					if (files.some((file) => file.path.includes('/.git/')) && ++gitWriteAttempts > 1) {
						throw new Error('Git pack write failed');
					}
				},
			};
			const provisioner = new SandboxProvisioner(fakeComputeFrom(failingInstance));
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			await bucketHandle.put(version.workspaceFile('app.py'), 'import marimo as mo');
			await bucketHandle.put(version.gitFile('HEAD'), 'ref: refs/heads/main\n');
			await bucketHandle.put(
				version.gitFile('objects/pack/pack-a.pack'),
				new Uint8Array(8 * 1024 * 1024),
			);

			await expect(
				provisioner.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					bucketHandle,
					entryNotebook: 'app.py',
					workspaceLoadMode: 'copy-only',
					workspacePrefix: version.workspacePrefix,
					gitPrefix: version.gitPrefix,
				}),
			).rejects.toThrow('restoring Git metadata into the sandbox');
			expect(gitWriteAttempts).toBeGreaterThan(1);
			expect(calls.writeFiles.flat().map((file) => file.path)).toEqual(
				expect.arrayContaining([
					`${MOUNT_PATH}/.git/HEAD`,
					`${MOUNT_PATH}/.git/objects/pack/pack-a.pack`,
				]),
			);
			expect(calls.startProcess).toHaveLength(0);
			expect(calls.destroy).toBe(1);
		});

		it('fails provisioning when the stored Git directory is empty', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			await bucketHandle.put(version.workspaceFile('app.py'), 'import marimo as mo');

			await expect(
				provisioner.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					bucketHandle,
					entryNotebook: 'app.py',
					workspaceLoadMode: 'copy-only',
					workspacePrefix: version.workspacePrefix,
					gitPrefix: version.gitPrefix,
				}),
			).rejects.toThrow('restoring Git metadata into the sandbox');
			expect(calls.startProcess).toHaveLength(0);
			expect(calls.destroy).toBe(1);
		});

		it('fails provisioning instead of skipping an unsafe Git metadata path', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const bucketHandle = new MemoryBucket();
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
			await bucketHandle.put(version.workspaceFile('app.py'), 'import marimo as mo');
			await bucketHandle.put(version.gitFile('HEAD'), 'ref: refs/heads/main\n');
			await bucketHandle.put(`${version.gitPrefix}../config`, 'unsafe');

			await expect(
				provisioner.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					bucketHandle,
					entryNotebook: 'app.py',
					workspaceLoadMode: 'copy-only',
					workspacePrefix: version.workspacePrefix,
					gitPrefix: version.gitPrefix,
				}),
			).rejects.toThrow('restoring Git metadata into the sandbox');
			expect(calls.writeFiles.flat().some((file) => file.path.includes('/.git/'))).toBe(false);
			expect(calls.startProcess).toHaveLength(0);
			expect(calls.destroy).toBe(1);
		});

		it('fails provisioning when Git metadata has no bucket handle', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const version = paths.project(projectId).notebook(notebookId).version(createVersionId());

			await expect(
				provisioner.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
					entryNotebook: 'app.py',
					workspacePrefix: version.workspacePrefix,
					gitPrefix: version.gitPrefix,
				}),
			).rejects.toThrow('restoring Git metadata into the sandbox');
			expect(calls.mountBucket).toHaveLength(1);
			expect(calls.startProcess).toHaveLength(0);
			expect(calls.destroy).toBe(1);
		});

		it('uses the injected workspace loader selected by workspaceLoadMode', async () => {
			const { instance, calls } = makeFakeSandbox();
			const selected: string[] = [];
			const loaders: WorkspaceLoadStrategies = {
				copyOnly: {
					async load(ctx) {
						selected.push(`copy:${ctx.projectId}:${ctx.notebookId}`);
						return { usedFallback: true, stats: { objectCount: 2, bytes: 40 } };
					},
				},
				mountOrCopy: {
					async load() {
						selected.push('mount');
						return { usedFallback: false };
					},
				},
			};
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance), loaders);

			const result = await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				workspaceLoadMode: 'copy-only',
			});

			expect(result.usedFallback).toBe(true);
			expect(selected).toEqual([`copy:${projectId}:${notebookId}`]);
			expect(calls.mountBucket).toHaveLength(0);
			expect(calls.startProcess).toHaveLength(1);
			// What the copy moved rides the same wide event, so a slow `files` phase is
			// attributable to workspace size rather than guesswork.
			expect(result.counters).toMatchObject({ files_objects: 2, files_bytes: 40 });
		});

		it('reports the compute backend as unavailable when the reachability probe fails', async () => {
			const { instance, calls } = makeFakeSandbox({ failExec: 'true' });
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await expect(
				provisioner.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				}),
			).rejects.toThrow('Sandbox compute backend is not available');

			// Never got past the reachability check.
			expect(calls.mountBucket).toHaveLength(0);
			expect(calls.startProcess).toHaveLength(0);
		});

		it('rethrows the original provisioning error when the cleanup destroy also throws', async () => {
			const { instance: base } = makeFakeSandbox({ failExec: 'true' });
			// Provisioning fails at reachability; the compensating destroy then also
			// throws. The caller must see the original failure, not the destroy error.
			const instance = {
				...base,
				destroy: async () => {
					throw new Error('destroy boom');
				},
			} as unknown as SandboxInstance;
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await expect(
				provisioner.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				}),
			).rejects.toThrow(/not available/i);
		});
	});

	describe('teardown', () => {
		it('reads the notebook back, cuts a version with HTML + session snapshots, then destroys', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const created = await env.notebooks.createNotebook(
				project.id,
				{ title: 'NB', description: 'd', code: 'print(1)' },
				ACTOR,
			);
			const nb = paths.project(project.id).notebook(created.id);

			const { instance, calls } = makeFakeSandbox({
				files: {
					[`${MOUNT_PATH}/notebook.py`]: 'print(2)  # edited',
					[`${MOUNT_PATH}/pyproject.toml`]: '[project]\nname = "edited"',
					[`${MOUNT_PATH}/__marimo__/notebook.html`]: '<html>output</html>',
					[`${MOUNT_PATH}/__marimo__/session/notebook.py.json`]: '{"version":"1"}',
				},
			});
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await provisioner.teardown(
				instance,
				env.notebooks,
				env.bucket,
				project.id,
				created.id,
				ACTOR,
				'source',
			);

			// Read all four artifacts (code, deps, the two __marimo__ snapshots) back.
			expect(calls.readFile).toContain(`${MOUNT_PATH}/notebook.py`);
			expect(calls.readFile).toContain(`${MOUNT_PATH}/__marimo__/notebook.html`);
			expect(calls.readFile).toContain(`${MOUNT_PATH}/__marimo__/session/notebook.py.json`);

			expect(await (await env.bucket.get(nb.code))?.text()).toBe('print(2)  # edited');

			// A new version was cut (initial + this one) and source points at it.
			expect(await env.notebooks.listVersions(project.id, created.id)).toHaveLength(2);
			const source = await (await env.bucket.get(nb.source))!.json<any>();
			const ver = nb.version(source.current_version_id);

			// HTML + session snapshots landed in that version's folder, with descriptors.
			expect(await (await env.bucket.get(ver.html))?.text()).toBe('<html>output</html>');
			expect(await (await env.bucket.get(ver.session))?.text()).toBe('{"version":"1"}');
			const verMeta = await (await env.bucket.get(ver.meta))!.json<any>();
			expect(verMeta.html_snapshot.size_bytes).toBeGreaterThan(0);
			expect(verMeta.session_snapshot.size_bytes).toBeGreaterThan(0);

			expect(calls.destroy).toBe(1);
		});

		it('with no edited files read back, cuts no version but still destroys', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const created = await env.notebooks.createNotebook(
				project.id,
				{ title: 'NB', description: 'd', code: 'print(1)' },
				ACTOR,
			);
			const { instance, calls } = makeFakeSandbox(); // sandbox reports no files

			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			await provisioner.teardown(
				instance,
				env.notebooks,
				env.bucket,
				project.id,
				created.id,
				ACTOR,
				'source',
			);

			// Nothing read back → no new version, but the sandbox is still destroyed.
			expect(await env.notebooks.listVersions(project.id, created.id)).toHaveLength(1);
			expect(calls.destroy).toBe(1);
		});

		it('still destroys the sandbox when commitSession throws (best-effort)', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			// A NotebookService whose commit fails must not block teardown.
			const failingNotebooks = {
				getNotebook: async () => ({ source: makeLocalSource() }),
				commitSession: async () => {
					throw new Error('commit boom');
				},
			} as unknown as NotebookService;

			await provisioner.teardown(
				instance,
				failingNotebooks,
				new MemoryBucket(),
				projectId,
				notebookId,
				ACTOR,
				'source',
			);

			expect(calls.destroy).toBe(1);
		});

		it('persistEdits: false destroys without reading back, committing, or snapshotting', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const created = await env.notebooks.createNotebook(
				project.id,
				{ title: 'NB', description: 'd', code: 'print(1)' },
				ACTOR,
			);
			const { instance, calls } = makeFakeSandbox({
				files: {
					[`${MOUNT_PATH}/notebook.py`]: 'print(2)  # viewer edit',
					[`${MOUNT_PATH}/__marimo__/notebook.html`]: '<html>output</html>',
				},
			});
			const compute = makeSnapshotCompute(instance, { captureId: 'snap_new' });
			const provisioner = new SandboxProvisioner(compute);

			await provisioner.teardown(
				instance,
				env.notebooks,
				env.bucket,
				project.id,
				created.id,
				ACTOR,
				'workspace',
				undefined,
				{ persistEdits: false },
			);

			expect(calls.readFile).toHaveLength(0);
			expect(await env.notebooks.listVersions(project.id, created.id)).toHaveLength(1);
			expect(await env.notebooks.getFsSnapshot(project.id, created.id)).toBeNull();
			expect(calls.destroy).toBe(1);
		});

		it("workspace mode: captures runtime files into the notebook's workspace, then destroys", async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const created = await env.notebooks.createNotebook(
				project.id,
				{ title: 'NB', description: 'd', code: 'print(1)' },
				ACTOR,
			);
			const nb = paths.project(project.id).notebook(created.id);

			// A working dir with source files plus a generated runtime file.
			const { instance, calls } = makeFsSandbox({
				files: {
					'notebook.py': 'print(2)',
					'pyproject.toml': '[project]',
					'data/cars.csv': 'a,b\n1,2\n',
				},
			});
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await provisioner.teardown(
				instance,
				env.notebooks,
				env.bucket,
				project.id,
				created.id,
				ACTOR,
				'workspace',
			);

			// Runtime file persisted under workspace/; source stays out of it (commitSession owns it).
			expect(await (await env.bucket.get(nb.workspaceFile('data/cars.csv')))?.text()).toBe(
				'a,b\n1,2\n',
			);
			expect(calls.destroy).toBe(1);
		});

		it('still destroys the sandbox when captureWorkspace throws (best-effort)', async () => {
			const { instance: base, calls } = makeFakeSandbox();
			// Fail only the capture listing (no includeHidden); readSessionArtifacts passes
			// includeHidden:true and is left to succeed.
			const instance = {
				...base,
				listFiles: async (path: string, options?: { includeHidden?: boolean }) => {
					if (options?.includeHidden) return { success: true, files: [] };
					throw new Error('list boom');
				},
			} as unknown as SandboxInstance;
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await provisioner.teardown(
				instance,
				{
					getNotebook: async () => ({ source: makeLocalSource() }),
					commitSession: async () => null,
				} as unknown as NotebookService,
				new MemoryBucket(),
				projectId,
				notebookId,
				ACTOR,
				'workspace',
			);

			expect(calls.destroy).toBe(1);
		});

		it('still destroys the sandbox when captureFilesystemSnapshot fails (best-effort)', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const created = await env.notebooks.createNotebook(
				project.id,
				{ title: 'NB', description: 'd', code: 'print(1)' },
				ACTOR,
			);
			const { instance, calls } = makeFakeSandbox({
				files: { [`${MOUNT_PATH}/notebook.py`]: 'print(2)  # edited' },
			});
			// The snapshot capture API is down; teardown must swallow it and still destroy.
			const compute = makeSnapshotCompute(instance, { failCapture: true });
			const provisioner = new SandboxProvisioner(compute);

			await provisioner.teardown(
				instance,
				env.notebooks,
				env.bucket,
				project.id,
				created.id,
				ACTOR,
				'source',
			);

			expect(calls.destroy).toBe(1);
		});

		it('GitHub teardown destroys without reading back or persisting edits', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const { meta } = await env.notebooks.synced.create(
				project.id,
				{
					title: 'GitHub NB',
					description: 'd',
					repo: 'org/repo',
					branch: 'main',
					entry_notebook: 'app.py',
				},
				ACTOR,
			);
			await env.notebooks.synced.sync(project.id, meta.id, {
				repo: 'org/repo',
				branch: 'main',
				root_path: '',
				commit: 'abc123',
				files: [{ path: 'app.py', bytes: new TextEncoder().encode('print("cached")') }],
			});
			const { instance, calls } = makeFakeSandbox({
				files: { [`${MOUNT_PATH}/app.py`]: 'print("edited")' },
			});
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await provisioner.teardown(
				instance,
				env.notebooks,
				env.bucket,
				project.id,
				meta.id,
				ACTOR,
				'workspace',
			);

			expect(calls.readFile).toHaveLength(0);
			expect(calls.destroy).toBe(1);
			expect(await env.notebooks.getNotebookContent(project.id, meta.id)).toBe('print("cached")');
			expect(await env.notebooks.listVersions(project.id, meta.id)).toHaveLength(1);
		});
	});

	describe('captureSession', () => {
		it('saves the session edits as a version WITHOUT destroying the sandbox', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const created = await env.notebooks.createNotebook(
				project.id,
				{ title: 'NB', description: 'd', code: 'print(1)' },
				ACTOR,
			);
			const { instance, calls } = makeFakeSandbox({
				files: { [`${MOUNT_PATH}/notebook.py`]: 'print(2)  # edited' },
			});
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			const saved = await provisioner.captureSession(
				instance,
				env.notebooks,
				env.bucket,
				project.id,
				created.id,
				ACTOR,
				'source',
			);

			expect(saved).toBe(true);
			expect(await env.notebooks.listVersions(project.id, created.id)).toHaveLength(2);
			expect(calls.destroy).toBe(0);
		});

		it('does not cut a new version when the content is unchanged (dedupe)', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const created = await env.notebooks.createNotebook(
				project.id,
				{ title: 'NB', description: 'd', code: 'print(1)' },
				ACTOR,
			);
			const { instance } = makeFakeSandbox({
				files: { [`${MOUNT_PATH}/notebook.py`]: 'print(2)  # edited' },
			});
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const capture = () =>
				provisioner.captureSession(
					instance,
					env.notebooks,
					env.bucket,
					project.id,
					created.id,
					ACTOR,
					'source',
				);

			await capture();
			await capture(); // same content read back again

			expect(await env.notebooks.listVersions(project.id, created.id)).toHaveLength(2);
		});

		it('returns false for a synced source (session edits are never persisted)', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const { meta } = await env.notebooks.synced.create(
				project.id,
				{
					title: 'GitHub NB',
					description: 'd',
					repo: 'org/repo',
					branch: 'main',
					entry_notebook: 'app.py',
				},
				ACTOR,
			);
			const { instance, calls } = makeFakeSandbox({
				files: { [`${MOUNT_PATH}/app.py`]: 'print("edited")' },
			});
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			const saved = await provisioner.captureSession(
				instance,
				env.notebooks,
				env.bucket,
				project.id,
				meta.id,
				ACTOR,
				'workspace',
			);

			expect(saved).toBe(false);
			expect(calls.readFile).toHaveLength(0);
			expect(calls.destroy).toBe(0);
		});

		it('persistEdits: false returns false without touching the sandbox or the bucket', async () => {
			const { instance, calls } = makeFakeSandbox({
				files: { [`${MOUNT_PATH}/notebook.py`]: 'print(2)' },
			});
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const notebooks = { getNotebook: vi.fn() } as unknown as NotebookService;

			const saved = await provisioner.captureSession(
				instance,
				notebooks,
				new MemoryBucket(),
				projectId,
				notebookId,
				ACTOR,
				'workspace',
				undefined,
				{ persistEdits: false },
			);

			expect(saved).toBe(false);
			expect(notebooks.getNotebook).not.toHaveBeenCalled();
			expect(calls.readFile).toHaveLength(0);
		});

		it('rethrows a commit failure (after the workspace capture) so callers retry', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const failingNotebooks = {
				getNotebook: async () => ({ source: makeLocalSource() }),
				commitSession: async () => {
					throw new Error('commit boom');
				},
			} as unknown as NotebookService;

			await expect(
				provisioner.captureSession(
					instance,
					failingNotebooks,
					new MemoryBucket(),
					projectId,
					notebookId,
					ACTOR,
					'source',
				),
			).rejects.toThrow('commit boom');
			expect(calls.destroy).toBe(0);
		});

		it('rethrows when the source policy cannot be read (never commit blind)', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const commitSession = vi.fn();
			const failingNotebooks = {
				getNotebook: async () => {
					throw new Error('metadata unavailable');
				},
				commitSession,
			} as unknown as NotebookService;

			await expect(
				provisioner.captureSession(
					instance,
					failingNotebooks,
					new MemoryBucket(),
					projectId,
					notebookId,
					ACTOR,
					'source',
				),
			).rejects.toThrow('metadata unavailable');
			expect(commitSession).not.toHaveBeenCalled();
			expect(calls.destroy).toBe(0);
		});

		it('throws the workspace error and logs the commit error when both reject', async () => {
			const { instance: base, calls } = makeFakeSandbox();
			// Fail the workspace capture (listFiles without includeHidden); the commit
			// (readSessionArtifacts passes includeHidden:true) is failed via commitSession.
			const instance = {
				...base,
				listFiles: async (_path: string, options?: { includeHidden?: boolean }) => {
					if (options?.includeHidden) return { success: true, files: [] };
					throw new Error('workspace list boom');
				},
			} as unknown as SandboxInstance;
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const failingNotebooks = {
				getNotebook: async () => ({ source: makeLocalSource() }),
				commitSession: async () => {
					throw new Error('commit boom');
				},
			} as unknown as NotebookService;
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			// The workspace error is surfaced to the caller...
			await expect(
				provisioner.captureSession(
					instance,
					failingNotebooks,
					new MemoryBucket(),
					projectId,
					notebookId,
					ACTOR,
					'workspace',
				),
			).rejects.toThrow('workspace list boom');

			// ...and the otherwise-masked commit failure is logged, not dropped.
			expect(
				errorSpy.mock.calls.some(([line]) => {
					if (typeof line !== 'string') return false;
					const event = JSON.parse(line) as Record<string, unknown>;
					return event.event === 'session_commit_failed';
				}),
			).toBe(true);
			expect(errorSpy.mock.calls.join('\n')).not.toContain('commit boom');
			expect(calls.destroy).toBe(0);
			errorSpy.mockRestore();
		});

		it('includeWorkspace: false saves the source but never touches the workspace mirror', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const created = await env.notebooks.createNotebook(
				project.id,
				{ title: 'NB', description: 'd', code: 'print(1)' },
				ACTOR,
			);
			const nb = paths.project(project.id).notebook(created.id);
			const { instance } = makeFsSandbox({
				files: {
					'notebook.py': 'print(2)',
					'data/cars.csv': 'a,b\n1,2\n',
				},
			});
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			const saved = await provisioner.captureSession(
				instance,
				env.notebooks,
				env.bucket,
				project.id,
				created.id,
				ACTOR,
				'workspace',
				undefined,
				{ includeWorkspace: false },
			);

			expect(saved).toBe(true);
			expect(await env.notebooks.listVersions(project.id, created.id)).toHaveLength(2);
			expect(await env.bucket.get(nb.workspaceFile('data/cars.csv'))).toBeNull();
		});
	});

	// Integration: the provisioner delegates to the filesystemSnapshots module at the
	// two lifecycle moments (the module's own logic is unit-tested separately).
	describe('filesystem snapshots (delegation)', () => {
		it('teardown captures a snapshot, writes the pointer, and GCs the previous one', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const created = await env.notebooks.createNotebook(
				project.id,
				{ title: 'NB', description: 'd', code: 'print(1)' },
				ACTOR,
			);
			// A previous snapshot that latest-wins GC should delete.
			await env.notebooks.setFsSnapshot(project.id, created.id, {
				snapshot_id: 'snap_old',
				captured_at: '2020-01-01T00:00:00.000Z',
			});

			const { instance, calls } = makeFakeSandbox();
			const compute = makeSnapshotCompute(instance, { captureId: 'snap_new' });
			const provisioner = new SandboxProvisioner(compute);

			await provisioner.teardown(
				instance,
				env.notebooks,
				env.bucket,
				project.id,
				created.id,
				ACTOR,
				'source',
			);

			const fs = await env.notebooks.getFsSnapshot(project.id, created.id);
			expect(fs?.snapshot_id).toBe('snap_new');
			expect(fs?.size_bytes).toBe(123);
			expect(compute.deleted).toEqual(['snap_old']); // previous reclaimed
			expect(calls.destroy).toBe(1);
		});

		it('provision restores via createFromSnapshot when a snapshot id is given', async () => {
			const { instance } = makeFakeSandbox();
			const compute = makeSnapshotCompute(instance);
			const provisioner = new SandboxProvisioner(compute);

			await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				restoreFilesystemSnapshotId: 'snap_x',
			});

			expect(compute.createdFrom).toEqual([{ id: sandboxId, snapshotId: 'snap_x' }]);
		});
	});
});
