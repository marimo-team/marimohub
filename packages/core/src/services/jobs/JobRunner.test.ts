import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ARTIFACT_BYTES } from '../../constants';
import { Millis } from '../../duration';
import type { NotebookId, ProjectId } from '../../ids';
import { paths } from '../../paths';
import type { ExecOptions, ExecResult, SandboxInstance } from '../../ports/sandbox';
import type { JobDefinition, JobRun } from '../../schema';
import { ACTOR, fakeComputeFrom, makeFakeSandbox, setupTestEnv, uid } from '../../testing';
import type { SandboxCalls } from '../../testing';
import { listAllKeys } from '../catalog/storage';
import {
	classifyExport,
	JobRunner,
	jobShellCommand,
	MAX_RUN_LOG_BYTES,
	parseExitCode,
} from './JobRunner';

const WORKDIR = '/workspace';
const OUTPUT = `${WORKDIR}/__marimo__/job_output.html`;

interface JobSandbox {
	instance: SandboxInstance;
	calls: SandboxCalls;
	/** Commands the job runner executed (the ones carrying the exit marker). */
	jobCommands: string[];
}

/** A fake sandbox whose export command answers with the given exit status and output. */
function makeJobSandbox(
	opts: {
		exitCode?: number | null;
		timedOut?: boolean;
		html?: string;
		stderr?: string;
		stdout?: string;
	} = {},
): JobSandbox {
	const files: Record<string, string> = {};
	if (opts.html !== undefined) files[OUTPUT] = opts.html;
	const { instance, calls } = makeFakeSandbox({ files });
	const jobCommands: string[] = [];
	const baseExec = instance.exec.bind(instance);
	instance.exec = async (cmd: string, options?: ExecOptions): Promise<ExecResult> => {
		if (!cmd.includes('__MARIMOHUB_JOB_EXIT__')) return baseExec(cmd, options);
		jobCommands.push(cmd);
		calls.exec.push(cmd);
		const exitCode = opts.exitCode === undefined ? 0 : opts.exitCode;
		return {
			success: true,
			stdout: `${opts.stdout ?? 'notebook output'}\n${exitCode === null ? '' : `__MARIMOHUB_JOB_EXIT__ ${exitCode} ${opts.timedOut ? 'timeout' : 'exit'}\n`}`,
			stderr: opts.stderr ?? '',
		};
	};
	return { instance, calls, jobCommands };
}

describe('JobRunner', () => {
	let env: Awaited<ReturnType<typeof setupTestEnv>>;
	let pid: ProjectId;
	let nid: NotebookId;
	let job: JobDefinition;

	beforeEach(async () => {
		env = await setupTestEnv();
		const project = await env.projects.createProject({ name: 'p', description: '' }, ACTOR);
		pid = project.id;
		const notebook = await env.notebooks.createNotebook(
			pid,
			{ title: 'nb', description: '', code: 'import marimo' },
			ACTOR,
		);
		nid = notebook.id;
		job = await env.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR);
	});

	function runner(
		sandbox: JobSandbox,
		overrides: Partial<ConstructorParameters<typeof JobRunner>[0]> = {},
	) {
		return new JobRunner({
			bucket: env.bucket,
			compute: fakeComputeFrom(sandbox.instance),
			notebooks: env.notebooks,
			projects: env.projects,
			jobs: env.jobs,
			runs: env.jobRuns,
			sandbox: { bucket: { name: 'b', endpoint: 'https://s3' }, workdir: WORKDIR },
			...overrides,
		});
	}

	const enqueue = (overrides: Partial<Parameters<typeof env.jobRuns.enqueue>[0]> = {}) =>
		env.jobRuns.enqueue({
			job,
			trigger: 'manual',
			triggeredBy: ACTOR,
			timeoutSeconds: 900,
			...overrides,
		});

	it('runs the export headlessly, captures the output, and destroys the sandbox', async () => {
		const log = vi.spyOn(console, 'log');
		const sandbox = makeJobSandbox({ html: '<html>rendered</html>' });
		const queued = await enqueue({ parameters: { name: "O'Brien" } });
		const workspaceBefore = await listAllKeys(
			env.bucket,
			paths.project(pid).notebook(nid).workspacePrefix,
		);

		const run = await runner(sandbox).execute(queued);

		expect(run).toMatchObject({
			status: 'succeeded',
			exit_code: 0,
			sandbox_id: expect.stringMatching(/^sb-/),
			started_at: expect.any(String),
			finished_at: expect.any(String),
			deadline_at: expect.any(String),
			output: { html_bytes: 21, logs_bytes: expect.any(Number) },
		});
		expect(run.error).toBeUndefined();
		expect(await env.jobRuns.readHtml(run)).toBe('<html>rendered</html>');
		expect(await env.jobRuns.readLogs(run)).toBe('notebook output');

		// The export command: copy-only sandbox, marimo export html, quoted cli args after `--`.
		expect(sandbox.jobCommands).toHaveLength(1);
		const command = sandbox.jobCommands[0];
		expect(command).toContain(`cd '${WORKDIR}'`);
		expect(command).toContain("marimo export html 'notebook.py' -o '__marimo__/job_output.html'");
		expect(command).toContain(`-- --name 'O'\\''Brien'`);
		expect(command).toContain('timeout -k 30 900');
		expect(sandbox.calls.mountBucket).toHaveLength(0);
		expect(sandbox.calls.startProcess).toHaveLength(0);
		expect(sandbox.calls.exposePort).toHaveLength(0);
		expect(sandbox.calls.destroy).toBe(1);

		// Never writes back: the workspace mirror and version chain are untouched.
		expect(await listAllKeys(env.bucket, paths.project(pid).notebook(nid).workspacePrefix)).toEqual(
			workspaceBefore,
		);
		expect(await env.notebooks.listVersions(pid, nid)).toHaveLength(1);
		expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).not.toBeNull();
		const wideEvent = log.mock.calls
			.map(([message]) => String(message))
			.find((message) => message.includes('"event":"job_run"'));
		expect(JSON.parse(wideEvent!)).toMatchObject({
			run_files_objects: expect.any(Number),
			run_files_bytes: expect.any(Number),
		});
		log.mockRestore();
	});

	it('loads the source version pinned when the run was queued', async () => {
		const [initial] = await env.notebooks.listVersions(pid, nid);
		const sourceVersionId = initial.version_id;
		const queued = await enqueue({ sourceVersionId });
		await env.notebooks.updateNotebook(pid, nid, { code: 'print("new")' }, ACTOR);
		const get = vi.spyOn(env.bucket, 'get');
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const run = await runner(sandbox).execute(queued);
		expect(run.status).toBe('succeeded');
		const pinned = paths.project(pid).notebook(nid).version(sourceVersionId);
		expect(get.mock.calls.some(([key]) => key === pinned.code)).toBe(true);
		expect(get.mock.calls.some(([key]) => key === pinned.deps)).toBe(true);
		const notebookWrites = sandbox.calls.writeFile.filter(
			(file) => file.path === `${WORKDIR}/notebook.py`,
		);
		expect(notebookWrites.at(-1)?.content).toEqual(new TextEncoder().encode('import marimo'));
	});

	it('marks a cell failure as failed but still keeps the rendered output', async () => {
		const sandbox = makeJobSandbox({ exitCode: 1, html: '<html>partial</html>', stderr: 'boom' });
		const run = await runner(sandbox).execute(await enqueue());
		expect(run).toMatchObject({
			status: 'failed',
			exit_code: 1,
			error: { code: 'NOTEBOOK_FAILED' },
			output: { html_bytes: 20 },
		});
		expect(await env.jobRuns.readLogs(run)).toBe('notebook output\nboom');
		expect(sandbox.calls.destroy).toBe(1);
	});

	it('marks a timeout exit as timed_out', async () => {
		const sandbox = makeJobSandbox({ exitCode: 124, timedOut: true });
		const run = await runner(sandbox).execute(await enqueue());
		expect(run).toMatchObject({
			status: 'timed_out',
			exit_code: 124,
			error: { code: 'RUN_TIMED_OUT' },
		});
		expect(sandbox.calls.destroy).toBe(1);
	});

	it('treats a notebook exit 124 as a failure rather than a timeout', async () => {
		const sandbox = makeJobSandbox({ exitCode: 124 });
		const run = await runner(sandbox).execute(await enqueue());
		expect(run).toMatchObject({
			status: 'failed',
			exit_code: 124,
			error: { code: 'NOTEBOOK_FAILED' },
		});
	});

	it('fails when the export exits cleanly without producing output', async () => {
		const sandbox = makeJobSandbox({ exitCode: 0 });
		const run = await runner(sandbox).execute(await enqueue());
		expect(run.status).toBe('failed');
		expect(run.error?.code).toBe('NOTEBOOK_FAILED');
	});

	it('fails with a sanitized error when the sandbox cannot be prepared', async () => {
		const { instance, calls } = makeFakeSandbox({ failExec: 'true' });
		const run = await runner({ instance, calls, jobCommands: [] }).execute(await enqueue());
		expect(run.status).toBe('failed');
		expect(run.error).toEqual({
			code: 'SERVICE_UNAVAILABLE',
			message: 'Sandbox compute backend is not available',
		});
		expect(calls.destroy).toBe(1);
		expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).not.toBeNull();
	});

	it('stops before provisioning when the run was cancelled while queued', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const queued = await enqueue();
		await env.jobRuns.cancel(queued, uid('someone'));
		const run = await runner(sandbox).execute(queued);
		expect(run.status).toBe('cancelled');
		expect(sandbox.calls.exec).toHaveLength(0);
		expect(sandbox.jobCommands).toHaveLength(0);
	});

	it('destroys the sandbox and keeps cancelled when a cancel lands mid-provision', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const queued = await enqueue();
		// Cancel from inside the reachability check: the sandbox is being prepared
		// but the run has not yet gone `running`.
		const baseExec = sandbox.instance.exec.bind(sandbox.instance);
		sandbox.instance.exec = async (cmd, options) => {
			if (cmd === 'true') await env.jobRuns.cancel(queued, uid('someone'));
			return baseExec(cmd, options);
		};
		const run = await runner(sandbox).execute(queued);
		expect(run.status).toBe('cancelled');
		expect(sandbox.jobCommands).toHaveLength(0);
		expect(sandbox.calls.destroy).toBeGreaterThanOrEqual(1);
	});

	it('fails a run whose notebook was deleted before dispatch', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const queued = await enqueue();
		await env.notebooks.deleteNotebook(pid, nid, ACTOR);
		const run = await runner(sandbox).execute(queued);
		expect(run.status).toBe('failed');
		expect(run.error?.code).toBe('NOT_FOUND');
		expect(sandbox.calls.exec).toHaveLength(0);
	});

	it('injects the resolved session env before the export runs', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		let seen: JobRun | undefined;
		const run = await runner(sandbox, {
			resolveSessionEnv: async (context) => {
				seen = context.run;
				return {
					vars: { AWS_ACCESS_KEY_ID: 'AKIA' },
					files: [{ path: '/tmp/creds', content: 'x' }],
				};
			},
		}).execute(await enqueue());
		expect(run.status).toBe('succeeded');
		expect(seen?.status).toBe('provisioning');
		expect(sandbox.calls.setEnvVars).toEqual([{ AWS_ACCESS_KEY_ID: 'AKIA' }]);
		expect(sandbox.calls.writeFile).toContainEqual({ path: '/tmp/creds', content: 'x' });
	});
});

describe('JobRunner unhappy paths', () => {
	let env: Awaited<ReturnType<typeof setupTestEnv>>;
	let pid: ProjectId;
	let nid: NotebookId;
	let job: JobDefinition;

	beforeEach(async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		env = await setupTestEnv();
		const project = await env.projects.createProject({ name: 'p', description: '' }, ACTOR);
		pid = project.id;
		const notebook = await env.notebooks.createNotebook(
			pid,
			{ title: 'nb', description: '', code: 'import marimo' },
			ACTOR,
		);
		nid = notebook.id;
		job = await env.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function runner(
		sandbox: JobSandbox,
		overrides: Partial<ConstructorParameters<typeof JobRunner>[0]> = {},
	) {
		return new JobRunner({
			bucket: env.bucket,
			compute: fakeComputeFrom(sandbox.instance),
			notebooks: env.notebooks,
			projects: env.projects,
			jobs: env.jobs,
			runs: env.jobRuns,
			sandbox: { bucket: { name: 'b', endpoint: 'https://s3' }, workdir: WORKDIR },
			...overrides,
		});
	}

	const enqueue = () =>
		env.jobRuns.enqueue({ job, trigger: 'manual', triggeredBy: ACTOR, timeoutSeconds: 900 });

	it('fails with a class-name-only error when the export exec rejects', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const baseExec = sandbox.instance.exec.bind(sandbox.instance);
		sandbox.instance.exec = async (cmd, options) => {
			if (cmd.includes('__MARIMOHUB_JOB_EXIT__')) throw new Error('grpc stream reset: secret=abc');
			return baseExec(cmd, options);
		};
		const run = await runner(sandbox).execute(await enqueue());
		expect(run.status).toBe('failed');
		expect(run.error).toEqual({ code: 'RUN_FAILED', message: 'The run failed (Error)' });
		expect(JSON.stringify(run)).not.toContain('secret=abc');
		expect(sandbox.calls.destroy).toBe(1);
		expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).not.toBeNull();
	});

	it('lands timed_out when the exec RPC itself times out without a marker', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const baseExec = sandbox.instance.exec.bind(sandbox.instance);
		sandbox.instance.exec = async (cmd, options) => {
			if (!cmd.includes('__MARIMOHUB_JOB_EXIT__')) return baseExec(cmd, options);
			return {
				success: false,
				stdout: '',
				stderr: 'command timed out after 900000ms',
				error: { code: 'COMMAND_FAILED' },
			};
		};
		const run = await runner(sandbox).execute(await enqueue());
		expect(run).toMatchObject({ status: 'timed_out', error: { code: 'RUN_TIMED_OUT' } });
		expect(run.exit_code).toBeUndefined();
	});

	it('lands timed_out when the exec never returns, once the in-process deadline passes', async () => {
		vi.useFakeTimers();
		try {
			const sandbox = makeJobSandbox({ html: '<html/>' });
			const baseExec = sandbox.instance.exec.bind(sandbox.instance);
			sandbox.instance.exec = (cmd, options) =>
				cmd.includes('__MARIMOHUB_JOB_EXIT__') ? new Promise(() => {}) : baseExec(cmd, options);
			const queued = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const pending = runner(sandbox).execute(queued);
			await vi.advanceTimersByTimeAsync(Millis.seconds(60) + Millis.minutes(3));
			const run = await pending;
			expect(run).toMatchObject({ status: 'timed_out', error: { code: 'RUN_TIMED_OUT' } });
			expect(run.output).toBeUndefined();
			expect(sandbox.calls.destroy).toBe(1);
			expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('lands timed_out when context loading exceeds the persisted deadline', async () => {
		vi.useFakeTimers();
		try {
			const sandbox = makeJobSandbox({ html: '<html/>' });
			vi.spyOn(env.projects, 'getProject').mockImplementation(() => new Promise(() => {}));
			const queued = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const pending = runner(sandbox).execute(queued);
			await vi.advanceTimersByTimeAsync(Millis.minutes(11) + 1);
			const run = await pending;
			expect(run).toMatchObject({
				status: 'timed_out',
				deadline_at: expect.any(String),
				error: { code: 'RUN_TIMED_OUT' },
			});
			expect(sandbox.calls.exec).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('lands timed_out when provisioning exceeds the persisted deadline', async () => {
		vi.useFakeTimers();
		try {
			const sandbox = makeJobSandbox({ html: '<html/>' });
			const queued = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const pending = runner(sandbox, {
				provisioner: { prepare: () => new Promise(() => {}) } as never,
			}).execute(queued);
			await vi.advanceTimersByTimeAsync(Millis.minutes(11) + 1);
			const run = await pending;
			expect(run).toMatchObject({ status: 'timed_out', error: { code: 'RUN_TIMED_OUT' } });
			expect(sandbox.jobCommands).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('lands timed_out when output persistence exceeds the persisted deadline', async () => {
		vi.useFakeTimers();
		try {
			const sandbox = makeJobSandbox({ html: '<html/>' });
			vi.spyOn(env.jobRuns, 'putOutputs').mockImplementation(() => new Promise(() => {}));
			const queued = await env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });
			const pending = runner(sandbox).execute(queued);
			await vi.advanceTimersByTimeAsync(Millis.minutes(11) + 1);
			const run = await pending;
			expect(run).toMatchObject({ status: 'timed_out', error: { code: 'RUN_TIMED_OUT' } });
			expect(run.output).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('fails when the captured outputs cannot be persisted', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		vi.spyOn(env.jobRuns, 'putOutputs').mockRejectedValueOnce(new Error('bucket down'));
		const run = await runner(sandbox).execute(await enqueue());
		expect(run).toMatchObject({ status: 'failed', error: { code: 'RUN_FAILED' } });
		expect(sandbox.calls.destroy).toBe(1);
	});

	it('still finishes the run when destroying the sandbox throws', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		sandbox.instance.destroy = async () => {
			throw new Error('provider unavailable');
		};
		const run = await runner(sandbox).execute(await enqueue());
		expect(run.status).toBe('succeeded');
		expect(await env.bucket.head(paths.jobRunMarker(pid, run.run_id))).not.toBeNull();
		expect(
			vi
				.mocked(console.error)
				.mock.calls.some((c) => String(c[0]).includes('job_sandbox_destroy_failed')),
		).toBe(true);
	});

	it('keeps only the tail of oversized logs', async () => {
		const sandbox = makeJobSandbox({
			html: '<html/>',
			stdout: 'x'.repeat(MAX_RUN_LOG_BYTES + 5000),
		});
		const run = await runner(sandbox).execute(await enqueue());
		expect(run.status).toBe('succeeded');
		const logs = (await env.jobRuns.readLogs(run))!;
		expect(logs.startsWith('[… ')).toBe(true);
		expect(new TextEncoder().encode(logs).byteLength).toBeLessThanOrEqual(MAX_RUN_LOG_BYTES + 64);
		expect(run.output?.logs_bytes).toBeLessThanOrEqual(MAX_RUN_LOG_BYTES + 64);
	});

	it('does not persist marimo session state without a restore API', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const { instance } = makeFakeSandbox({
			files: {
				[OUTPUT]: '<html/>',
				[`${WORKDIR}/__marimo__/session/notebook.py.json`]: '{"cells":[]}',
			},
		});
		sandbox.instance.readFile = instance.readFile;
		const run = await runner(sandbox).execute(await enqueue());
		expect(run.output).toMatchObject({ html_bytes: 7 });
		expect(run.output).not.toHaveProperty('session_bytes');
		expect(
			await env.bucket.head(
				`${paths.project(pid).notebook(nid).job(job.id).run(run.run_id).base}session.json`,
			),
		).toBeNull();
	});

	it('omits an export past the artifact cap instead of buffering it', async () => {
		const sandbox = makeJobSandbox({ html: '<html>huge</html>' });
		sandbox.instance.listFiles = async (path) =>
			path === `${WORKDIR}/__marimo__`
				? {
						success: true,
						files: [
							{
								name: 'job_output.html',
								absolutePath: OUTPUT,
								relativePath: '__marimo__/job_output.html',
								type: 'file',
								size: MAX_ARTIFACT_BYTES + 1,
							},
						],
					}
				: { success: true, files: [] };
		const run = await runner(sandbox).execute(await enqueue());
		expect(run).toMatchObject({ status: 'failed', error: { code: 'NOTEBOOK_FAILED' } });
		expect(run.error?.message).toContain('without producing output');
		expect(sandbox.calls.readFile).not.toContain(OUTPUT);
	});

	it('fails closed when the credential env cannot be resolved', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const run = await runner(sandbox, {
			resolveSessionEnv: async () => {
				throw new Error('integration render failed: password=hunter2');
			},
		}).execute(await enqueue());
		expect(run.status).toBe('failed');
		expect(run.error).toEqual({
			code: 'SERVICE_UNAVAILABLE',
			message: 'Failed to start sandbox while resolving credentials',
		});
		expect(sandbox.jobCommands).toHaveLength(0);
		expect(sandbox.calls.destroy).toBeGreaterThanOrEqual(1);
	});

	it('keeps a cancel that lands while the export is running', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const queued = await enqueue();
		const baseExec = sandbox.instance.exec.bind(sandbox.instance);
		sandbox.instance.exec = async (cmd, options) => {
			if (cmd.includes('__MARIMOHUB_JOB_EXIT__')) await env.jobRuns.cancel(queued, uid('someone'));
			return baseExec(cmd, options);
		};
		const run = await runner(sandbox).execute(queued);
		expect(run.status).toBe('cancelled');
		expect(run.cancelled_by).toBe('someone');
		// The captured output is still stored for inspection; the record stays cancelled.
		expect(await env.jobRuns.readHtml(run)).toBe('<html/>');
		expect(sandbox.calls.destroy).toBe(1);
	});

	it('fails a git-synced notebook that has not been synced yet', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const detail = await env.notebooks.getNotebook(pid, nid);
		vi.spyOn(env.notebooks, 'getNotebook').mockResolvedValue({
			...detail,
			source: {
				schema_version: 1,
				type: 'git',
				provider: 'github',
				repo: 'org/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'app.py',
				sync_mode: 'push',
				current_version_id: null,
				commit: null,
				last_synced_at: null,
			},
		});
		const run = await runner(sandbox).execute(await enqueue());
		expect(run.status).toBe('failed');
		expect(run.error?.message).toContain('has not been synced');
		expect(sandbox.jobCommands).toHaveLength(0);
	});

	it('fails when the job definition was deleted before dispatch', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const queued = await enqueue();
		await env.jobs.finishDelete(pid, nid, job.id);
		// The delete wiped the run record too; the runner reports the missing run.
		await expect(runner(sandbox).execute(queued)).rejects.toThrow('not found');
		expect(sandbox.calls.exec).toHaveLength(0);
	});

	it('fails when the project is soft-deleted', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const queued = await enqueue();
		await env.projects.deleteProject(pid, ACTOR);
		const run = await runner(sandbox).execute(queued);
		expect(run).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
	});

	it('applies the notebook’s compute profile only when editors may override', async () => {
		await env.notebooks.updateNotebook(pid, nid, { compute_profile: 'large' }, ACTOR);
		const profiles = [
			{ name: 'small', resources: { cpu: 1 } },
			{ name: 'large', resources: { cpu: 4 } },
		];
		const locked = makeJobSandbox({ html: '<html/>' });
		const lockedCompute = fakeComputeFrom(locked.instance);
		await runner(locked, {
			compute: lockedCompute,
			sandbox: {
				bucket: { name: 'b' },
				workdir: WORKDIR,
				computeProfiles: profiles,
				computeProfileOverride: 'none',
			},
		}).execute(await enqueue());
		expect(lockedCompute.lastCreateOptions?.resources).toEqual({ cpu: 1 });

		const open = makeJobSandbox({ html: '<html/>' });
		const openCompute = fakeComputeFrom(open.instance);
		const openRun = await runner(open, {
			compute: openCompute,
			sandbox: {
				bucket: { name: 'b' },
				workdir: WORKDIR,
				images: ['ghcr.io/org/default:1', 'ghcr.io/org/gpu:1'],
				computeProfiles: profiles,
				computeProfileOverride: 'editors',
			},
		}).execute(await enqueue());
		expect(openCompute.lastCreateOptions?.resources).toEqual({ cpu: 4 });
		// The applied image and profile are recorded on the run, as on a session.
		expect(openRun).toMatchObject({
			image: 'ghcr.io/org/default:1',
			compute_profile: 'large',
			compute_resources: { cpu: 4 },
		});

		// A profile the operator removed falls back to the default and is logged.
		await env.notebooks.updateNotebook(pid, nid, { compute_profile: 'gone' }, ACTOR);
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const fallback = makeJobSandbox({ html: '<html/>' });
		const fallbackCompute = fakeComputeFrom(fallback.instance);
		await runner(fallback, {
			compute: fallbackCompute,
			sandbox: {
				bucket: { name: 'b' },
				workdir: WORKDIR,
				computeProfiles: profiles,
				computeProfileOverride: 'editors',
			},
		}).execute(await enqueue());
		expect(fallbackCompute.lastCreateOptions?.resources).toEqual({ cpu: 1 });
		expect(logSpy.mock.calls.some((c) => String(c[0]).includes('stored_config_fallback'))).toBe(
			true,
		);
	});
});

describe('JobRunner provenance', () => {
	let env: Awaited<ReturnType<typeof setupTestEnv>>;
	let pid: ProjectId;
	let nid: NotebookId;
	let job: JobDefinition;

	beforeEach(async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		env = await setupTestEnv();
		const project = await env.projects.createProject({ name: 'p', description: '' }, ACTOR);
		pid = project.id;
		const notebook = await env.notebooks.createNotebook(
			pid,
			{ title: 'nb', description: '', code: 'import marimo' },
			ACTOR,
		);
		nid = notebook.id;
		job = await env.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const enqueue = () => env.jobRuns.enqueue({ job, trigger: 'manual', timeoutSeconds: 60 });

	it('boots the notebook’s stored base image and records it', async () => {
		await env.notebooks.updateNotebook(pid, nid, { base_image: 'ghcr.io/org/gpu:1' }, ACTOR);
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const compute = fakeComputeFrom(sandbox.instance);
		const run = await new JobRunner({
			bucket: env.bucket,
			compute,
			notebooks: env.notebooks,
			projects: env.projects,
			jobs: env.jobs,
			runs: env.jobRuns,
			sandbox: {
				bucket: { name: 'b' },
				workdir: WORKDIR,
				images: ['ghcr.io/org/default:1', 'ghcr.io/org/gpu:1'],
			},
		}).execute(await enqueue());
		expect(compute.lastCreateOptions?.image).toBe('ghcr.io/org/gpu:1');
		expect(run.image).toBe('ghcr.io/org/gpu:1');
	});

	it('falls back to the default image when the stored one is no longer offered, and logs it', async () => {
		await env.notebooks.updateNotebook(pid, nid, { base_image: 'ghcr.io/org/retired:1' }, ACTOR);
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const compute = fakeComputeFrom(sandbox.instance);
		const run = await new JobRunner({
			bucket: env.bucket,
			compute,
			notebooks: env.notebooks,
			projects: env.projects,
			jobs: env.jobs,
			runs: env.jobRuns,
			sandbox: { bucket: { name: 'b' }, workdir: WORKDIR, images: ['ghcr.io/org/default:1'] },
		}).execute(await enqueue());
		expect(compute.lastCreateOptions?.image).toBe('ghcr.io/org/default:1');
		expect(run.image).toBe('ghcr.io/org/default:1');
		expect(
			vi.mocked(console.log).mock.calls.some((c) => String(c[0]).includes('"config":"base_image"')),
		).toBe(true);
	});

	it('records the default profile name when the notebook stores none', async () => {
		const sandbox = makeJobSandbox({ html: '<html/>' });
		const run = await new JobRunner({
			bucket: env.bucket,
			compute: fakeComputeFrom(sandbox.instance),
			notebooks: env.notebooks,
			projects: env.projects,
			jobs: env.jobs,
			runs: env.jobRuns,
			sandbox: {
				bucket: { name: 'b' },
				workdir: WORKDIR,
				computeProfile: 'standard',
				resources: { cpu: 2, memoryBytes: 1024 },
			},
		}).execute(await enqueue());
		expect(run).toMatchObject({
			compute_profile: 'standard',
			compute_resources: { cpu: 2, memory_bytes: 1024 },
		});
		expect(run.image).toBeUndefined();
	});
});

describe('jobShellCommand', () => {
	it('bounds the command, echoes the exit status, and quotes parameters', () => {
		const command = jobShellCommand('/w', 'uv run marimo export html', 30, { k: 'v w' });
		expect(command).toContain("cd '/w'");
		expect(command).toContain("rm -f '__marimo__/job_output.html'");
		expect(command).toContain('timeout -k 30 30 sh -c');
		expect(command).toContain('uv run marimo export html -- --k');
		expect(command).toContain("'__marimo__/.job_exit_status'");
		expect(command).toContain('case "$status" in 124|137) outcome=timeout');
		expect(command).toMatch(/printf '\\n__MARIMOHUB_JOB_EXIT__ %s %s\\n' "\$status" "\$outcome"$/);
		expect(parseExitCode('x\n__MARIMOHUB_JOB_EXIT__ 3 exit\n')).toBe(3);
		expect(parseExitCode('__MARIMOHUB_JOB_EXIT__ 9 exit\nreal output')).toBeUndefined();
		expect(parseExitCode('__MARIMOHUB_JOB_EXIT__ 9 exit\n__MARIMOHUB_JOB_EXIT__ 3 timeout\n')).toBe(
			3,
		);
		expect(parseExitCode('no marker')).toBeUndefined();
	});
});

describe('classifyExport', () => {
	const ok: ExecResult = { success: true, stdout: '', stderr: '' };
	const failed = (stderr = ''): ExecResult => ({
		success: false,
		stdout: '',
		stderr,
		error: { code: 'COMMAND_FAILED' },
	});

	it('succeeds only with a zero status and an output file', () => {
		expect(classifyExport({ result: ok, exitCode: 0, hasHtml: true, timeoutSeconds: 60 })).toEqual({
			event: 'succeed',
		});
		expect(
			classifyExport({ result: ok, exitCode: 0, hasHtml: false, timeoutSeconds: 60 }),
		).toMatchObject({ event: 'fail', error: { code: 'NOTEBOOK_FAILED' } });
	});

	it('uses the timeout outcome or an exec-level timeout', () => {
		expect(
			classifyExport({
				result: ok,
				exitCode: 124,
				timedOut: true,
				hasHtml: false,
				timeoutSeconds: 60,
			}),
		).toEqual({
			event: 'timeout',
			error: { code: 'RUN_TIMED_OUT', message: 'The run exceeded its 60s timeout' },
		});
		expect(
			classifyExport({
				result: failed('command timed out after 60000ms'),
				exitCode: undefined,
				hasHtml: false,
				timeoutSeconds: 60,
			}).event,
		).toBe('timeout');
	});

	it('does not infer a timeout from exit status 124 alone', () => {
		expect(
			classifyExport({ result: ok, exitCode: 124, hasHtml: false, timeoutSeconds: 60 }),
		).toMatchObject({ event: 'fail', error: { code: 'NOTEBOOK_FAILED' } });
	});

	it('distinguishes a cell failure, a missing export, and an exec failure', () => {
		const cells = classifyExport({ result: ok, exitCode: 1, hasHtml: true, timeoutSeconds: 60 });
		expect(cells.error).toMatchObject({ code: 'NOTEBOOK_FAILED' });
		expect(cells.error?.message).toContain('One or more cells failed');
		const missing = classifyExport({ result: ok, exitCode: 2, hasHtml: false, timeoutSeconds: 60 });
		expect(missing.error?.message).toContain('without producing output');
		expect(
			classifyExport({ result: failed(), exitCode: undefined, hasHtml: false, timeoutSeconds: 60 }),
		).toEqual({
			event: 'fail',
			error: { code: 'RUN_FAILED', message: 'The export command failed (COMMAND_FAILED)' },
		});
		expect(
			classifyExport({ result: ok, exitCode: undefined, hasHtml: true, timeoutSeconds: 60 }).error
				?.message,
		).toContain('no exit status');
	});
});
