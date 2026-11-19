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
	const coordinator = new SessionCaptureCoordinator({
		...env,
		compute: fakeComputeFrom(env.instance),
		persistWorkspace: 'workspace',
	});
	return {
		...env,
		session,
		coordinator,
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
