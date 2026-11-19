import { createServices } from '../index';
import { bucketStorage } from '../../ports/metadata';
import { NotebookService } from '../content/NotebookService';
import { CatalogService } from '../catalog/CatalogService';
import * as logs from '../../logs';
import * as operationalLog from '../../operationalLog';
import { createSandboxId, createVersionId } from '../../ids';
import { SessionCaptureCoordinator } from './SessionCaptureCoordinator';
import { RuntimeCaptureClient, RuntimeMissingError } from './runtimeCapture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTOR, fakeComputeFrom, makeFsSandbox, setupTestEnv } from '../../testing';
import { paths } from '../../paths';
import { MAX_ARTIFACT_BYTES } from '../../constants';
import { execResult, readFileFailure } from '../../ports/sandbox';
import { SandboxProvisioner } from './SandboxProvisioner';

async function fixture(
	files: Record<string, string> = { 'notebook.py': '# edited', 'data.csv': '1' },
) {
	const env = await setupTestEnv();
	const project = await env.projects.createProject({ name: 'Capture', description: '' }, ACTOR);
	const notebook = await env.notebooks.createNotebook(
		project.id,
		{ title: 'Capture', description: '', code: '# original' },
		ACTOR,
	);
	const { instance, calls } = makeFsSandbox({ files });
	const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
	const capture = (opts?: {
		includeWorkspace?: boolean;
		persistEdits?: boolean;
		assertOwnership?: () => Promise<void>;
	}) =>
		provisioner.captureSessionResult(
			instance,
			env.notebooks,
			env.bucket,
			project.id,
			notebook.id,
			ACTOR,
			'workspace',
			undefined,
			opts,
		);
	return {
		...env,
		project,
		notebook,
		instance,
		calls,
		provisioner,
		capture,
		nb: paths.project(project.id).notebook(notebook.id),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function coordinatorFixture() {
	const env = await fixture();
	const session = await env.sessions.createSession({
		project_id: env.project.id,
		notebook_id: env.notebook.id,
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
	});
	await env.sessions.claimEditor(env.project.id, env.notebook.id, session.session_id, 'shared');
	const prepare = vi.spyOn(RuntimeCaptureClient.prototype, 'prepare').mockResolvedValue({
		token: 'checkpoint',
		directory: '/workspace',
	});
	const resume = vi.spyOn(RuntimeCaptureClient.prototype, 'resume').mockResolvedValue();
	const log = vi.spyOn(logs, 'logEvent');
	const metrics = { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
	const coordinator = new SessionCaptureCoordinator({
		...env,
		compute: fakeComputeFrom(env.instance),
		persistWorkspace: 'workspace',
		metrics,
	});
	return {
		...env,
		session,
		coordinator,
		metrics,
		prepare,
		resume,
		log,
		storedSession: () => env.sessions.getSession(env.project.id, session.session_id),
		incompleteEvents: () =>
			log.mock.calls
				.map(([event]) => event)
				.filter((event) => event.event === 'session_capture_incomplete'),
	};
}

describe('capture failure diagnostics and recovery', () => {
	it.each([null, 300_000, -60_000])(
		'reports prior capture age %s without leaking runtime errors',
		async (age) => {
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
			const f = await coordinatorFixture();
			const at = age === null ? undefined : new Date(Date.now() - age).toISOString();
			f.prepare.mockRejectedValue(new Error('secret-token=private-notebook-content'));
			const result = await f.coordinator.capture(
				{
					...f.session,
					...(at ? { last_durable_capture: { at, version_id: createVersionId() } } : {}),
				},
				f.instance,
			);
			expect(result.critical).toMatchObject({
				status: 'failed',
				code: 'RUNTIME_CAPTURE_UNAVAILABLE',
			});
			const events = f.incompleteEvents();
			expect(events).toEqual([
				expect.objectContaining({
					last_durable_capture_at: at ?? null,
					durable_capture_age_ms: age === null ? null : Math.max(0, age),
				}),
			]);
			expect(JSON.stringify(events)).not.toContain('secret-token');
			expect(f.resume).not.toHaveBeenCalled();
			expect(f.calls.destroy).toBe(0);
		},
	);

	it.each(['publication', 'receipt'] as const)(
		'resumes the runtime and retries after a lost %s acknowledgement',
		async (failure) => {
			const f = await coordinatorFixture();
			if (failure === 'publication') {
				const commit = f.notebooks.commitSession.bind(f.notebooks);
				vi.spyOn(f.notebooks, 'commitSession').mockImplementationOnce(async (...args) => {
					await commit(...args);
					throw new Error('acknowledgement lost');
				});
			} else {
				vi.spyOn(f.sessions, 'recordDurableCapture').mockRejectedValueOnce(
					new Error('receipt unavailable'),
				);
			}
			const result = await f.coordinator.capture(f.session, f.instance, {
				retainRuntime: true,
				includeWorkspace: false,
			});
			const code = failure === 'publication' ? 'PUBLICATION_UNCERTAIN' : 'CAPTURE_RECEIPT_FAILED';
			expect(result).toMatchObject({
				critical: { status: 'uncertain', code },
				runtimeState: 'running',
			});
			expect(f.metrics.histogram.mock.calls.map(([name]) => name)).not.toContain(
				'sessions.capture.durable_ms',
			);
			expect(f.metrics.increment).not.toHaveBeenCalledWith('sessions.capture.durable');
			expect(f.metrics.histogram).toHaveBeenCalledWith(
				'sessions.capture.phase_ms',
				expect.any(Number),
				{ phase: failure === 'publication' ? 'publication' : 'receipt', outcome: 'failed' },
			);
			expect(result.runtime).toBeUndefined();
			expect(f.resume).toHaveBeenCalledOnce();
			expect(f.calls.destroy).toBe(0);
			expect((await f.storedSession()).last_durable_capture).toBeUndefined();
			expect(await f.notebooks.getNotebookContent(f.project.id, f.notebook.id)).toBe('# edited');
			expect(f.log).toHaveBeenCalledWith(
				expect.objectContaining({
					event: 'session_capture_incomplete',
					code,
					critical_status: 'uncertain',
				}),
			);
			expect(
				(await f.coordinator.capture(f.session, f.instance, { includeWorkspace: false })).critical
					.status,
			).toBe('durable');
			expect((await f.storedSession()).last_durable_capture).toBeDefined();
		},
	);

	it('records critical durability despite workspace failure and reports the separate failure', async () => {
		const f = await coordinatorFixture();
		const put = f.bucket.put.bind(f.bucket);
		vi.spyOn(f.bucket, 'put').mockImplementation((key, value, options) => {
			if (key === f.nb.workspaceFile('data.csv')) throw new Error('private workspace error');
			return put(key, value, options);
		});
		expect(await f.coordinator.capture(f.session, f.instance)).toMatchObject({
			critical: { status: 'durable' },
			workspace: { status: 'failed' },
			runtimeState: 'running',
		});
		expect((await f.storedSession()).last_durable_capture).toBeDefined();
		const event = f.incompleteEvents()[0];
		expect(event).toMatchObject({ critical_status: 'durable', workspace_status: 'failed' });
		expect(event).not.toHaveProperty('code');
		expect(JSON.stringify(event)).not.toContain('private workspace error');
		expect(f.resume).toHaveBeenCalledOnce();
	});

	it.each([false, true])(
		'resumes a background capture before publication (retainRuntime: %s)',
		async (retainRuntime) => {
			const f = await coordinatorFixture();
			const order: string[] = [];
			f.resume.mockImplementation(async () => {
				order.push('resume');
			});
			const commit = f.notebooks.commitSession.bind(f.notebooks);
			vi.spyOn(f.notebooks, 'commitSession').mockImplementation(async (...args) => {
				order.push('commit');
				return commit(...args);
			});
			const put = f.bucket.put.bind(f.bucket);
			vi.spyOn(f.bucket, 'put').mockImplementation((key, value, options) => {
				if (key === f.nb.source) order.push('put');
				return put(key, value, options);
			});
			const result = await f.coordinator.capture(f.session, f.instance, {
				retainRuntime,
				includeWorkspace: false,
			});
			expect(result.critical.status).toBe('durable');
			if (retainRuntime) {
				expect(result.runtimeState).toBe('paused');
				expect(order).not.toContain('resume');
			} else {
				expect(result.runtimeState).toBe('running');
				expect(order[0]).toBe('resume');
				expect(order.filter((step) => step === 'resume')).toHaveLength(1);
				expect(order).toContain('put');
			}
		},
	);

	it('preserves durable publication when the runtime disappears during resume', async () => {
		const f = await coordinatorFixture();
		const report = vi.spyOn(operationalLog, 'logOperationalError');
		f.resume.mockRejectedValue(new RuntimeMissingError('sandbox gone'));
		expect(
			await f.coordinator.capture(f.session, f.instance, { includeWorkspace: false }),
		).toMatchObject({
			critical: { status: 'durable' },
			runtimeState: 'missing',
		});
		expect((await f.storedSession()).last_durable_capture).toBeDefined();
		expect(f.log).not.toHaveBeenCalledWith(
			expect.objectContaining({ event: 'session_capture_incomplete' }),
		);
		expect(report).toHaveBeenCalledWith(
			'session_capture_resume_failed',
			expect.objectContaining({ session_id: f.session.session_id }),
			expect.any(RuntimeMissingError),
		);
	});
});

describe('session capture outcomes', () => {
	it.each(['final-capture', 'sandbox-loss', 'storage-failure', 'hub-restart'] as const)(
		'recovers published artifact bytes after %s',
		async (failure) => {
			const artifacts = (generation: string) => ({
				'notebook.py': `# ${generation}`,
				'pyproject.toml': `[project]\nname = "${generation}"`,
				'__marimo__/notebook.html': `<p>${generation}</p>`,
				'__marimo__/session/notebook.py.json': JSON.stringify({ generation }),
				'data.csv': generation,
			});
			const env = await fixture(artifacts('saved'));
			expect((await env.capture({ includeWorkspace: false })).critical.status).toBe('durable');
			await env.instance.writeFiles(
				Object.entries(artifacts('latest')).map(([path, content]) => ({
					path: `/workspace/${path}`,
					content,
				})),
			);
			if (failure === 'storage-failure') {
				const put = env.bucket.put.bind(env.bucket);
				vi.spyOn(env.bucket, 'put').mockImplementation((key, value, options) => {
					if (key === env.nb.source) throw new Error('storage unavailable');
					return put(key, value, options);
				});
				expect((await env.capture({ includeWorkspace: false })).critical.status).toBe('uncertain');
			} else if (failure === 'final-capture') {
				expect((await env.capture()).critical.status).toBe('durable');
			}
			const recovered = new NotebookService(env.bucket, new CatalogService(env.bucket));
			const head = await recovered.beginSessionCapture(env.project.id, env.notebook.id);
			const version = head.versions[0];
			const stored = env.nb.version(version.version_id);
			const expected = artifacts(failure === 'final-capture' ? 'latest' : 'saved');
			expect(await recovered.getNotebookContent(env.project.id, env.notebook.id)).toBe(
				expected['notebook.py'],
			);
			expect(await (await env.bucket.get(stored.deps))!.text()).toBe(expected['pyproject.toml']);
			expect(
				await (await env.bucket.get(
					stored.capture(version.html_snapshot!.capture_id!).html,
				))!.text(),
			).toBe(expected['__marimo__/notebook.html']);
			expect(
				await (await env.bucket.get(
					stored.capture(version.session_snapshot!.capture_id!).session,
				))!.text(),
			).toBe(expected['__marimo__/session/notebook.py.json']);
			const data = await env.bucket.get(env.nb.workspaceFile('data.csv'));
			expect(data ? await data.text() : null).toBe(failure === 'final-capture' ? 'latest' : null);
		},
	);

	it.each(['starting', 'ready', 'stopping', 'failed'] as const)(
		'defers background capture while a secondary writer is %s',
		async (status) => {
			const env = await coordinatorFixture();
			const { session, log, prepare, coordinator } = env;
			const commit = vi.spyOn(env.notebooks, 'commitSession');
			expect(
				await coordinator.capture({ ...session, surfaces: { vscode: { status } } }, env.instance),
			).toMatchObject({
				critical: { status: 'failed', code: 'CAPTURE_UNSUPPORTED', retryable: false },
				runtimeState: 'running',
			});
			expect(log).toHaveBeenCalledWith(
				expect.objectContaining({
					event: 'session_capture_incomplete',
					session_id: session.session_id,
					code: 'CAPTURE_UNSUPPORTED',
					last_durable_capture_at: null,
					durable_capture_age_ms: null,
				}),
			);
			expect(prepare).not.toHaveBeenCalled();
			expect(commit).not.toHaveBeenCalled();
			expect(env.calls.destroy).toBe(0);
		},
	);

	it('keeps an invalid artifact actionable after native checkpoint rejection and abort', async () => {
		const env = await fixture();
		const session = await env.sessions.createSession({
			project_id: env.project.id,
			notebook_id: env.notebook.id,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
		});
		await env.sessions.claimEditor(env.project.id, env.notebook.id, session.session_id, 'shared');
		const exec = vi
			.spyOn(env.instance, 'exec')
			.mockResolvedValueOnce(
				execResult(true, JSON.stringify({ ok: true, state: 'running', generation: 0 }), ''),
			)
			.mockResolvedValueOnce(
				execResult(true, JSON.stringify({ ok: false, code: 'CAPTURE_INVALID_PATH' }), ''),
			)
			.mockResolvedValueOnce(execResult(true, JSON.stringify({ ok: true, state: 'running' }), ''));
		const commit = vi.spyOn(env.notebooks, 'commitSession');
		const coordinator = new SessionCaptureCoordinator({
			...env,
			compute: fakeComputeFrom(env.instance),
			persistWorkspace: 'source',
		});
		expect(await coordinator.capture(session, env.instance)).toMatchObject({
			critical: { status: 'failed', code: 'ARTIFACT_INVALID', retryable: false },
			runtimeState: 'running',
		});
		expect(exec.mock.calls[2][0]).toContain('"action":"abort"');
		expect(commit).not.toHaveBeenCalled();
	});

	it('revalidates ownership after acquiring the publication token', async () => {
		const env = await fixture();
		const old = await env.sessions.createSession({
			project_id: env.project.id,
			notebook_id: env.notebook.id,
			user_id: ACTOR,
		});
		await env.sessions.claimEditor(env.project.id, env.notebook.id, old.session_id, 'shared');
		expect(await env.sessions.ownsEditorClaim(old)).toBe(true);
		await env.sessions.releaseEditorFor(old);
		const replacement = await env.sessions.createSession({
			project_id: env.project.id,
			notebook_id: env.notebook.id,
			user_id: ACTOR,
		});
		await env.sessions.claimEditor(
			env.project.id,
			env.notebook.id,
			replacement.session_id,
			'shared',
		);
		await env.notebooks.fenceSessionPublications(env.project.id, env.notebook.id);
		const begin = vi.spyOn(env.notebooks, 'beginSessionCapture');
		const validate = vi.fn(async () => {
			expect(begin).toHaveBeenCalledOnce();
			await env.sessions.assertCaptureOwnership(old);
		});
		const commit = vi.spyOn(env.notebooks, 'commitSession');
		expect(await env.capture({ assertOwnership: validate })).toMatchObject({
			critical: { status: 'failed' },
		});
		expect(validate).toHaveBeenCalledOnce();
		expect(commit).not.toHaveBeenCalled();
		expect(await env.notebooks.getNotebookContent(env.project.id, env.notebook.id)).toBe(
			'# original',
		);
	});

	it('returns the committed version and capture timestamp for critical success', async () => {
		const env = await fixture();
		const result = await env.capture();
		expect(result).toMatchObject({
			critical: {
				status: 'durable',
				capturedAt: expect.any(String),
				publication: { newVersion: true },
			},
			workspace: { status: 'captured' },
		});
		expect(await env.notebooks.getNotebookContent(env.project.id, env.notebook.id)).toBe(
			'# edited',
		);
		expect(env.calls.destroy).toBe(0);
	});

	it('does not report a durable capture when publication returns null', async () => {
		const env = await fixture();
		vi.spyOn(env.notebooks, 'commitSession').mockResolvedValue(null);
		expect(await env.capture()).toMatchObject({
			critical: { status: 'failed', code: 'SOURCE_NOT_COMMITTED', retryable: false },
		});
		expect(await env.notebooks.getNotebookContent(env.project.id, env.notebook.id)).toBe(
			'# original',
		);
	});

	it('does not publish a missing required source', async () => {
		const env = await fixture({});
		env.instance.readFileBounded = async () => readFileFailure('NOT_FOUND');
		const commit = vi.spyOn(env.notebooks, 'commitSession');
		expect(await env.capture()).toMatchObject({
			critical: { status: 'failed', code: 'SOURCE_MISSING', retryable: false },
		});
		expect(commit).not.toHaveBeenCalled();
	});

	it('keeps a critical read failure distinct from a bulk workspace failure', async () => {
		const env = await fixture();
		const read = env.instance.readFileBounded!.bind(env.instance);
		env.instance.readFileBounded = (path, options) =>
			path.endsWith('/notebook.py')
				? Promise.resolve(readFileFailure('READ_FAILED'))
				: read(path, options);
		const put = env.bucket.put.bind(env.bucket);
		vi.spyOn(env.bucket, 'put').mockImplementation((key, value, opts) =>
			key === env.nb.workspaceFile('data.csv')
				? Promise.reject(new Error('Bulk failure'))
				: put(key, value, opts),
		);
		const result = await env.capture();
		expect(result).toMatchObject({
			critical: { status: 'failed', code: 'SOURCE_UNAVAILABLE' },
			workspace: { status: 'failed' },
		});
		if (result.critical.status === 'failed')
			expect(result.critical.cause).toMatchObject({ code: 'READ_FAILED' });
	});

	it('preserves confirmed critical success when only bulk workspace capture fails', async () => {
		const env = await fixture();
		const put = env.bucket.put.bind(env.bucket);
		vi.spyOn(env.bucket, 'put').mockImplementation((key, value, opts) =>
			key === env.nb.workspaceFile('data.csv')
				? Promise.reject(new Error('Bulk failure'))
				: put(key, value, opts),
		);
		expect(await env.capture()).toMatchObject({
			critical: { status: 'durable' },
			workspace: { status: 'failed' },
		});
		expect(await env.notebooks.getNotebookContent(env.project.id, env.notebook.id)).toBe(
			'# edited',
		);
	});
	it.each([false, true])(
		'does not let optional HTML storage mask critical outcome (source failure: %s)',
		async (sourceFails) => {
			const env = await fixture({
				'notebook.py': '# edited',
				'__marimo__/notebook.html': '<p>output</p>',
			});
			const put = env.bucket.put.bind(env.bucket);
			vi.spyOn(env.bucket, 'put').mockImplementation((key, body, options) => {
				if (key.includes('/captures/') && key.endsWith('.html'))
					throw new Error('HTML unavailable');
				if (sourceFails && key === env.nb.source) throw new Error('Source unavailable');
				return put(key, body, options);
			});
			const result = await env.capture();
			expect(result.critical).toMatchObject(
				sourceFails
					? { status: 'uncertain', code: 'PUBLICATION_UNCERTAIN' }
					: { status: 'durable', publication: { capturedHtml: false } },
			);
		},
	);

	it('marks a lost publication acknowledgement uncertain even when bytes were committed', async () => {
		const env = await fixture();
		const put = env.bucket.put.bind(env.bucket);
		vi.spyOn(env.bucket, 'put').mockImplementation(async (key, value, opts) => {
			const result = await put(key, value, opts);
			if (key === env.nb.source) throw new Error('Acknowledgement lost');
			return result;
		});
		expect(await env.capture()).toMatchObject({
			critical: { status: 'uncertain', code: 'PUBLICATION_UNCERTAIN' },
		});
		expect(await env.notebooks.getNotebookContent(env.project.id, env.notebook.id)).toBe(
			'# edited',
		);
	});

	it('does not access the notebook or sandbox for discard-only captures', async () => {
		const env = await fixture();
		const get = vi.spyOn(env.notebooks, 'getNotebook');
		expect(await env.capture({ persistEdits: false })).toEqual({
			critical: { status: 'not_required', reason: 'discard' },
			workspace: { status: 'skipped' },
		});
		expect(get).not.toHaveBeenCalled();
		expect(env.calls.readFile).toHaveLength(0);
	});

	it('does not mirror bulk files during periodic source capture', async () => {
		const env = await fixture();
		expect(await env.capture({ includeWorkspace: false })).toMatchObject({
			critical: { status: 'durable' },
			workspace: { status: 'skipped' },
		});
		expect(await env.bucket.get(env.nb.workspaceFile('data.csv'))).toBeNull();
	});
	it.each(['pyproject.toml', '__marimo__/session/notebook.py.json'])(
		'rejects failed critical artifact reads for %s',
		async (relative) => {
			const env = await fixture();
			const read = env.instance.readFileBounded!.bind(env.instance);
			env.instance.readFileBounded = (path, options) =>
				path.endsWith(`/${relative}`)
					? Promise.resolve(readFileFailure('READ_FAILED'))
					: read(path, options);
			const commit = vi.spyOn(env.notebooks, 'commitSession');
			expect(await env.capture()).toMatchObject({
				critical: { status: 'failed', code: 'SOURCE_UNAVAILABLE' },
			});
			expect(commit).not.toHaveBeenCalled();
		},
	);

	it('does not block critical publication when optional HTML cannot be read', async () => {
		const env = await fixture();
		const read = env.instance.readFileBounded!.bind(env.instance);
		env.instance.readFileBounded = (path, options) =>
			path.endsWith('.html')
				? Promise.resolve(readFileFailure('READ_FAILED'))
				: read(path, options);
		expect(await env.capture()).toMatchObject({
			critical: { status: 'durable', publication: { capturedHtml: false } },
		});
	});

	it('reports unsupported bounded reads without claiming the source is missing', async () => {
		const env = await fixture();
		delete env.instance.readFileBounded;
		expect(await env.capture()).toMatchObject({
			critical: { status: 'failed', code: 'CAPTURE_UNSUPPORTED', retryable: false },
		});
	});

	it('reports an oversized critical source as non-retryable', async () => {
		const env = await fixture();
		const list = env.instance.listFiles.bind(env.instance);
		vi.spyOn(env.instance, 'listFiles').mockImplementation(async (...args) => {
			const result = await list(...args);
			if (result.success)
				for (const file of result.files) {
					if (file.relativePath === 'notebook.py') file.size = MAX_ARTIFACT_BYTES + 1;
				}
			return result;
		});
		const commit = vi.spyOn(env.notebooks, 'commitSession');
		expect(await env.capture()).toMatchObject({
			critical: { status: 'failed', code: 'ARTIFACT_TOO_LARGE', retryable: false },
		});
		expect(commit).not.toHaveBeenCalled();
	});
});

describe('capture instrumentation and publication fences', () => {
	it('measures visibility and durability after their writes, before optional workspace work', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'performance'] });
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const f = await coordinatorFixture();
		const acknowledgedAt = Date.now() - 100;
		const put = f.bucket.put.bind(f.bucket);
		vi.spyOn(f.bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === f.nb.source) vi.setSystemTime(Date.now() + 200);
			if (key === f.nb.workspaceFile('data.csv')) vi.setSystemTime(Date.now() + 1000);
			return put(key, value, options);
		});
		const receipt = f.sessions.recordDurableCapture.bind(f.sessions);
		vi.spyOn(f.sessions, 'recordDurableCapture').mockImplementation(async (...args) => {
			vi.setSystemTime(Date.now() + 50);
			return receipt(...args);
		});
		const get = vi.spyOn(f.notebooks, 'getNotebook');
		const result = await f.coordinator.capture(
			{
				...f.session,
				save_dirty: { id: 'dirty', acknowledged_at: new Date(acknowledgedAt).toISOString() },
			},
			f.instance,
		);
		expect(result.critical.status).toBe('durable');
		expect(f.metrics.histogram).toHaveBeenCalledWith(
			'sessions.capture.source_visible_lag_ms',
			300,
			undefined,
		);
		expect(f.metrics.histogram).toHaveBeenCalledWith(
			'sessions.capture.durable_lag_ms',
			350,
			undefined,
		);
		for (const phase of [
			'ownership',
			'prepare',
			'artifact_read',
			'resume',
			'source_publish',
			'receipt',
			'workspace',
		])
			expect(f.metrics.histogram).toHaveBeenCalledWith(
				'sessions.capture.phase_ms',
				expect.any(Number),
				{ phase, outcome: 'success' },
			);
		expect(f.metrics.histogram).toHaveBeenCalledWith('sessions.capture.artifact_bytes', 8, {
			artifact: 'code',
		});
		// Initial policy read and commit validation remain; the paused read is redundant.
		expect(get).toHaveBeenCalledTimes(2);
	});

	it('does not let a throwing metrics exporter change publication or resume', async () => {
		const f = await coordinatorFixture();
		f.metrics.histogram.mockImplementation(() => {
			throw new Error('export failed');
		});
		f.metrics.increment.mockImplementation(() => {
			throw new Error('export failed');
		});
		expect((await f.coordinator.capture(f.session, f.instance)).critical.status).toBe('durable');
		expect(f.resume).toHaveBeenCalledOnce();
		expect((await f.storedSession()).last_durable_capture).toBeDefined();
	});

	it('records a failed phase and permits a later successful capture', async () => {
		const f = await coordinatorFixture();
		f.prepare.mockRejectedValueOnce(new Error('private contents'));
		expect((await f.coordinator.capture(f.session, f.instance)).critical.status).toBe('failed');
		expect(f.metrics.histogram).toHaveBeenCalledWith(
			'sessions.capture.phase_ms',
			expect.any(Number),
			{ phase: 'prepare', outcome: 'failed' },
		);
		expect(f.metrics.histogram.mock.calls.map(([name]) => name)).not.toContain(
			'sessions.capture.durable_ms',
		);
		expect(JSON.stringify(f.metrics.histogram.mock.calls)).not.toContain('private contents');
		expect((await f.coordinator.capture(f.session, f.instance)).critical.status).toBe('durable');
	});

	it.each([false, true])(
		'fences an overlapping older capture after newer publication (stop: %s)',
		async (retainRuntime) => {
			const f = await coordinatorFixture();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const commit = f.notebooks.commitSession.bind(f.notebooks);
			vi.spyOn(f.notebooks, 'commitSession').mockImplementationOnce(async (...args) => {
				entered.resolve();
				await release.promise;
				return commit(...args);
			});
			const older = f.coordinator.capture(f.session, f.instance, { includeWorkspace: false });
			await entered.promise;
			try {
				await f.instance.writeFiles([{ path: '/workspace/notebook.py', content: '# newest' }]);
				expect(
					(
						await f.coordinator.capture(f.session, f.instance, {
							includeWorkspace: false,
							retainRuntime,
						})
					).critical.status,
				).toBe('durable');
			} finally {
				release.resolve();
			}
			expect((await older).critical.status).toBe('uncertain');
			const recovered = new NotebookService(f.bucket, new CatalogService(f.bucket));
			expect(await recovered.getNotebookContent(f.project.id, f.notebook.id)).toBe('# newest');
			expect(f.calls.destroy).toBe(0);
		},
	);

	it('publishes new native outputs with unchanged source, then skips identical uploads', async () => {
		const f = await coordinatorFixture();
		const output = '/workspace/__marimo__/session/notebook.py.json';
		await f.instance.writeFiles([{ path: output, content: '{"output":1}' }]);
		const first = await f.coordinator.capture(f.session, f.instance, { includeWorkspace: false });
		await f.instance.writeFiles([{ path: output, content: '{"output":2}' }]);
		const second = await f.coordinator.capture(f.session, f.instance, { includeWorkspace: false });
		expect(first.critical.status).toBe('durable');
		expect(second.critical).toMatchObject({
			status: 'durable',
			publication: { newVersion: false, capturedSession: true },
		});
		f.metrics.histogram.mockClear();
		expect(
			(await f.coordinator.capture(f.session, f.instance, { includeWorkspace: false })).critical
				.status,
		).toBe('durable');
		expect(
			f.metrics.histogram.mock.calls.some(([name]) => name === 'sessions.capture.uploaded_bytes'),
		).toBe(false);
		const recovered = new NotebookService(f.bucket, new CatalogService(f.bucket));
		const head = await recovered.beginSessionCapture(f.project.id, f.notebook.id);
		const version = head.versions[0];
		const key = f.nb
			.version(version.version_id)
			.capture(version.session_snapshot!.capture_id!).session;
		expect(await (await f.bucket.get(key))!.text()).toBe('{"output":2}');
	});
});

it('rejects an in-flight publication after editor replacement fences the source head', async () => {
	const f = await coordinatorFixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const commit = f.notebooks.commitSession.bind(f.notebooks);
	vi.spyOn(f.notebooks, 'commitSession').mockImplementationOnce(async (...args) => {
		entered.resolve();
		await release.promise;
		return commit(...args);
	});
	const capture = f.coordinator.capture(f.session, f.instance, { includeWorkspace: false });
	await entered.promise;
	try {
		await f.sessions.releaseEditorFor(f.session);
		const replacement = await f.sessions.createSession({
			project_id: f.project.id,
			notebook_id: f.notebook.id,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
		});
		await f.sessions.claimEditor(f.project.id, f.notebook.id, replacement.session_id, 'shared');
		await f.notebooks.fenceSessionPublications(f.project.id, f.notebook.id);
	} finally {
		release.resolve();
	}
	expect((await capture).critical).toMatchObject({
		status: 'uncertain',
		code: 'PUBLICATION_UNCERTAIN',
	});
	expect(await f.notebooks.getNotebookContent(f.project.id, f.notebook.id)).toBe('# original');
	expect((await f.storedSession()).last_durable_capture).toBeUndefined();
	expect(f.metrics.histogram.mock.calls.map(([name]) => name)).not.toContain(
		'sessions.capture.source_visible_ms',
	);
	expect(f.resume).toHaveBeenCalledOnce();
});

describe('capture boundary failures', () => {
	it('preserves a newer save acknowledgement that arrives during publication', async () => {
		const f = await coordinatorFixture();
		const first = await f.sessions.acknowledgeRuntimeSave(f.project.id, f.session.session_id);
		const commit = f.notebooks.commitSession.bind(f.notebooks);
		let newer: Awaited<ReturnType<typeof f.sessions.acknowledgeRuntimeSave>>;
		vi.spyOn(f.notebooks, 'commitSession').mockImplementationOnce(async (...args) => {
			newer = await f.sessions.acknowledgeRuntimeSave(f.project.id, f.session.session_id);
			return commit(...args);
		});
		expect(
			(await f.coordinator.capture(first, f.instance, { includeWorkspace: false })).critical.status,
		).toBe('durable');
		expect((await f.storedSession()).save_dirty).toEqual(newer!.save_dirty);
		expect(
			(await f.coordinator.capture(newer!, f.instance, { includeWorkspace: false })).critical
				.status,
		).toBe('durable');
		expect((await f.storedSession()).save_dirty).toBeUndefined();
	});

	it('records critical durability while optional workspace upload remains blocked', async () => {
		const f = await coordinatorFixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const put = f.bucket.put.bind(f.bucket);
		vi.spyOn(f.bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === f.nb.workspaceFile('data.csv')) {
				entered.resolve();
				await release.promise;
				throw new Error('workspace upload failed');
			}
			return put(key, value, options);
		});
		const capture = f.coordinator.capture(f.session, f.instance);
		await entered.promise;
		try {
			expect((await f.storedSession()).last_durable_capture).toBeDefined();
			expect(f.metrics.increment).toHaveBeenCalledWith('sessions.capture.durable');
			expect(f.resume).toHaveBeenCalledOnce();
		} finally {
			release.resolve();
		}
		expect(await capture).toMatchObject({
			critical: { status: 'durable' },
			workspace: { status: 'failed' },
			runtimeState: 'running',
		});
	});

	it('does not publish partial artifacts when the native session upload fails', async () => {
		const f = await coordinatorFixture();
		await f.instance.writeFiles([
			{ path: '/workspace/__marimo__/notebook.html', content: '<p>new</p>' },
			{ path: '/workspace/__marimo__/session/notebook.py.json', content: '{"output":1}' },
		]);
		const put = f.bucket.put.bind(f.bucket);
		vi.spyOn(f.bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key.includes('/captures/') && key.endsWith('.json'))
				throw new Error('session upload failed');
			return put(key, value, options);
		});
		expect(
			await f.coordinator.capture(f.session, f.instance, {
				retainRuntime: true,
				includeWorkspace: false,
			}),
		).toMatchObject({
			critical: { status: 'uncertain', code: 'PUBLICATION_UNCERTAIN' },
			runtimeState: 'running',
		});
		expect(await f.notebooks.getNotebookContent(f.project.id, f.notebook.id)).toBe('# original');
		expect((await f.storedSession()).last_durable_capture).toBeUndefined();
		expect(f.metrics.histogram.mock.calls.map(([name]) => name)).not.toContain(
			'sessions.capture.source_visible_ms',
		);
		expect(f.calls.destroy).toBe(0);
	});

	it('retains uncertainty when both publication and runtime resume fail', async () => {
		const f = await coordinatorFixture();
		vi.spyOn(f.notebooks, 'commitSession').mockRejectedValueOnce(
			new Error('publication unavailable'),
		);
		f.resume.mockRejectedValueOnce(new Error('resume unavailable'));
		expect(
			await f.coordinator.capture(f.session, f.instance, {
				retainRuntime: true,
				includeWorkspace: false,
			}),
		).toMatchObject({
			critical: { status: 'uncertain', code: 'PUBLICATION_UNCERTAIN', retryable: true },
			runtimeState: 'unknown',
		});
		expect(f.metrics.histogram).toHaveBeenCalledWith(
			'sessions.capture.phase_ms',
			expect.any(Number),
			{ phase: 'resume', outcome: 'failed' },
		);
		expect((await f.storedSession()).last_durable_capture).toBeUndefined();
		expect(f.calls.destroy).toBe(0);
		expect(
			(await f.coordinator.capture(f.session, f.instance, { includeWorkspace: false })).critical
				.status,
		).toBe('durable');
	});

	it('counts UTF-8 bytes and empty artifacts after resuming the background runtime', async () => {
		const f = await coordinatorFixture();
		await f.instance.writeFiles([
			{ path: '/workspace/notebook.py', content: '# é🙂' },
			{ path: '/workspace/__marimo__/notebook.html', content: '' },
		]);
		expect(
			(await f.coordinator.capture(f.session, f.instance, { includeWorkspace: false })).critical
				.status,
		).toBe('durable');
		expect(f.metrics.histogram).toHaveBeenCalledWith('sessions.capture.artifact_bytes', 8, {
			artifact: 'code',
		});
		expect(f.metrics.histogram).toHaveBeenCalledWith('sessions.capture.artifact_bytes', 0, {
			artifact: 'html',
		});
		const bytesCall = f.metrics.histogram.mock.calls.findIndex(
			([name]) => name === 'sessions.capture.artifact_bytes',
		);
		expect(f.resume).toHaveBeenCalledOnce();
		expect(f.resume.mock.invocationCallOrder[0]).toBeLessThan(
			f.metrics.histogram.mock.invocationCallOrder[bytesCall],
		);
	});

	it('clamps lag when a save acknowledgement is ahead of the local clock', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const f = await coordinatorFixture();
		expect(
			(
				await f.coordinator.capture(
					{
						...f.session,
						save_dirty: {
							id: 'future',
							acknowledged_at: new Date(Date.now() + 60_000).toISOString(),
						},
					},
					f.instance,
					{ includeWorkspace: false },
				)
			).critical.status,
		).toBe('durable');
		expect(f.metrics.histogram).toHaveBeenCalledWith(
			'sessions.capture.source_visible_lag_ms',
			0,
			undefined,
		);
		expect(f.metrics.histogram).toHaveBeenCalledWith(
			'sessions.capture.durable_lag_ms',
			0,
			undefined,
		);
	});
});

it.each(['wrong-attempt', 'wrong-lease', 'expired'] as const)(
	'rejects %s stop ownership before preparing a checkpoint',
	async (failure) => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const f = await coordinatorFixture();
		const requested = await f.sessions.requestStop(f.project.id, f.session.session_id);
		const leaseId = crypto.randomUUID();
		const claimed = (await f.sessions.claimStop(requested, leaseId))!;
		const lease = {
			attemptId: failure === 'wrong-attempt' ? crypto.randomUUID() : claimed.stop!.id,
			leaseId: failure === 'wrong-lease' ? crypto.randomUUID() : leaseId,
		};
		if (failure === 'expired') vi.setSystemTime(new Date(claimed.stop!.lease_expires_at!));
		const commit = vi.spyOn(f.notebooks, 'commitSession');
		expect(
			(
				await f.coordinator.capture(claimed, f.instance, {
					retainRuntime: true,
					includeWorkspace: false,
					stopLease: lease,
					assertOwnership: () => f.sessions.assertCaptureOwnership(claimed, lease),
				})
			).critical.status,
		).toBe('failed');
		expect(f.prepare).not.toHaveBeenCalled();
		expect(commit).not.toHaveBeenCalled();
		expect(f.metrics.histogram).toHaveBeenCalledWith(
			'sessions.capture.phase_ms',
			expect.any(Number),
			{ phase: 'ownership', outcome: 'failed' },
		);
		expect(f.calls.destroy).toBe(0);
	},
);

it.each([false, true])(
	'records transactional durability before metadata and catalog work (stop: %s)',
	async (retainRuntime) => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const f = await coordinatorFixture();
		const start = Date.now();
		let elapsed = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
		const advance = (ms: number) => {
			elapsed += ms;
			vi.setSystemTime(start + elapsed);
		};
		const services = createServices({
			...bucketStorage(f.bucket),
			transactions: {
				async run(_scopes, work) {
					const result = await work({
						records: f.bucket,
						sessions: { list: vi.fn().mockRejectedValue(new Error('Unexpected indexed query')) },
					});
					advance(200);
					return result;
				},
			},
		});
		let session = await services.sessions.acknowledgeRuntimeSave(
			f.project.id,
			f.session.session_id,
		);
		let stopLease: { attemptId: string; leaseId: string } | undefined;
		if (retainRuntime) {
			session = await services.sessions.requestStop(f.project.id, session.session_id);
			const leaseId = crypto.randomUUID();
			session = (await services.sessions.claimStop(session, leaseId))!;
			stopLease = { attemptId: session.stop!.id, leaseId };
		}
		const separateReceipt = vi.spyOn(services.sessions, 'recordDurableCapture');
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const put = f.bucket.put.bind(f.bucket);
		vi.spyOn(f.bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === f.nb.meta) {
				entered.resolve();
				await release.promise;
				advance(500);
			}
			return put(key, value, options);
		});
		const reconcile = services.catalog.updateNotebookEntry.bind(services.catalog);
		vi.spyOn(services.catalog, 'updateNotebookEntry').mockImplementation(async (...args) => {
			advance(700);
			return reconcile(...args);
		});
		const coordinator = new SessionCaptureCoordinator({
			...f,
			...services,
			compute: fakeComputeFrom(f.instance),
			persistWorkspace: 'source',
			metrics: f.metrics,
		});
		const capture = coordinator.capture(session, f.instance, {
			retainRuntime,
			includeWorkspace: false,
			stopLease,
			...(stopLease
				? { assertOwnership: () => services.sessions.assertCaptureOwnership(session, stopLease) }
				: {}),
		});
		await entered.promise;
		const atCommit = [...f.metrics.histogram.mock.calls];
		release.resolve();
		expect((await capture).critical.status).toBe('durable');
		expect(atCommit).toContainEqual(['sessions.capture.durable_ms', 200, undefined]);
		expect(atCommit).toContainEqual(['sessions.capture.durable_lag_ms', 200, undefined]);
		expect(
			f.metrics.histogram.mock.calls.filter(([name]) => name === 'sessions.capture.durable_ms'),
		).toHaveLength(1);
		expect(f.metrics.increment).toHaveBeenCalledExactlyOnceWith('sessions.capture.durable');
		expect(f.metrics.histogram).toHaveBeenCalledWith(
			'sessions.capture.total_ms',
			1400,
			expect.anything(),
		);
		expect(separateReceipt).not.toHaveBeenCalled();
		expect((await f.storedSession()).last_durable_capture).toBeDefined();
	},
);

it('does not report confirmed durability after a lost transaction acknowledgement', async () => {
	const f = await coordinatorFixture();
	const services = createServices({
		...bucketStorage(f.bucket),
		transactions: {
			async run(_scopes, work) {
				await work({
					records: f.bucket,
					sessions: { list: vi.fn().mockRejectedValue(new Error('Unexpected indexed query')) },
				});
				throw new Error('Commit acknowledgement lost');
			},
		},
	});
	const coordinator = new SessionCaptureCoordinator({
		...f,
		...services,
		compute: fakeComputeFrom(f.instance),
		persistWorkspace: 'source',
		metrics: f.metrics,
	});
	expect(
		await coordinator.capture(f.session, f.instance, {
			retainRuntime: true,
			includeWorkspace: false,
		}),
	).toMatchObject({
		critical: { status: 'uncertain', code: 'PUBLICATION_UNCERTAIN' },
		runtimeState: 'running',
	});
	expect((await f.storedSession()).last_durable_capture).toBeDefined();
	expect(f.metrics.histogram.mock.calls.map(([name]) => name)).not.toContain(
		'sessions.capture.durable_ms',
	);
	expect(f.metrics.increment).not.toHaveBeenCalledWith('sessions.capture.durable');
	expect(f.resume).toHaveBeenCalledOnce();
	expect(f.calls.destroy).toBe(0);
});
