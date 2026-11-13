import { createSandboxId } from '../../ids';
import { SessionCaptureCoordinator } from './SessionCaptureCoordinator';
import { RuntimeCaptureClient } from './runtimeCapture';
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

afterEach(() => vi.restoreAllMocks());

describe('session capture outcomes', () => {
	it.each(['starting', 'ready', 'stopping'] as const)(
		'defers background capture while a secondary writer is %s',
		async (status) => {
			const env = await fixture();
			const session = await env.sessions.createSession({
				project_id: env.project.id,
				notebook_id: env.notebook.id,
				user_id: ACTOR,
				sandbox_id: createSandboxId(),
			});
			await env.sessions.claimEditor(env.project.id, env.notebook.id, session.session_id, 'shared');
			const prepare = vi.spyOn(RuntimeCaptureClient.prototype, 'prepare');
			const commit = vi.spyOn(env.notebooks, 'commitSession');
			const coordinator = new SessionCaptureCoordinator({
				...env,
				compute: fakeComputeFrom(env.instance),
				persistWorkspace: 'source',
			});
			expect(
				await coordinator.capture({ ...session, surfaces: { vscode: { status } } }, env.instance),
			).toMatchObject({
				critical: { status: 'failed', code: 'CAPTURE_UNSUPPORTED', retryable: false },
				runtimeState: 'running',
			});
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
