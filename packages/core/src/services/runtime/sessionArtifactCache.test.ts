import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSandboxId } from '../../ids';
import { sha256Hex } from '../../internal/sha256';
import { ACTOR, fakeComputeFrom, makeFsSandbox, setupTestEnv } from '../../testing';
import { execResult, readFileFailure } from '../../ports/sandbox';
import { SessionArtifactCache, probeSessionArtifacts } from './sessionArtifactCache';
import type { ArtifactFingerprints, CachedSessionArtifacts } from './sessionArtifactCache';
import { paths as bucketPaths } from '../../paths';
import { SandboxProvisioner } from './SandboxProvisioner';
import { sessionArtifactPaths } from './sandboxFiles';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const env = await setupTestEnv();
	const project = await env.projects.createProject({ name: 'P', description: '' }, ACTOR);
	const notebook = await env.notebooks.createNotebook(
		project.id,
		{ title: 'N', description: '', code: 'before' },
		ACTOR,
	);
	const paths = sessionArtifactPaths('/workspace');
	const files: Record<string, string> = { [paths.code]: 'edited', [paths.html]: '<p>result</p>' };
	const { instance } = makeFsSandbox({
		files: { 'notebook.py': files[paths.code], '__marimo__/notebook.html': files[paths.html] },
	});
	const fingerprints = async () =>
		Object.fromEntries(
			await Promise.all(
				Object.entries(paths).map(async ([field, path]) => [
					field,
					files[path] === undefined
						? null
						: {
								size: new TextEncoder().encode(files[path]).byteLength,
								sha256: await sha256Hex(files[path]),
							},
				]),
			),
		) as ArtifactFingerprints;
	const probe = vi
		.spyOn(instance, 'exec')
		.mockImplementation(async () => execResult(true, JSON.stringify(await fingerprints()), ''));
	const read = vi.spyOn(instance, 'readFileBounded');
	const commit = vi.spyOn(env.notebooks, 'commitSession');
	const sandboxId = createSandboxId();
	const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
	return {
		...env,
		projectId: project.id,
		notebookId: notebook.id,
		instance,
		paths,
		files,
		probe,
		read,
		commit,
		fingerprints,
		capture: () =>
			provisioner.captureSession(
				{ ...instance },
				env.notebooks,
				env.bucket,
				project.id,
				notebook.id,
				ACTOR,
				'source',
				'/workspace',
				{ sandboxId, includeWorkspace: false },
			),
		change: async (field: keyof typeof paths, value: string) => {
			files[paths[field]] = value;
			await instance.writeFiles([{ path: paths[field], content: value }]);
		},
	};
}

describe('incremental autosave artifacts', () => {
	it('revalidates reused artifacts and commits without reading their contents', async () => {
		const f = await fixture();
		await f.capture();
		expect(f.read).toHaveBeenCalledTimes(2);
		f.read.mockClear();
		f.commit.mockClear();
		f.probe.mockClear();
		await f.capture();
		expect(f.probe).toHaveBeenCalledTimes(2);
		expect(f.probe).toHaveBeenCalledWith(expect.stringContaining('hashlib.sha256'), {
			timeout: 10_000,
			maxOutputBytes: 4096,
		});
		expect(f.read).not.toHaveBeenCalled();
		expect(f.commit).toHaveBeenCalledOnce();
	});

	it('repairs missing published artifacts even when cached files are unchanged', async () => {
		const f = await fixture();
		await f.capture();
		const { source } = await f.notebooks.getNotebook(f.projectId, f.notebookId);
		const version = bucketPaths
			.project(f.projectId)
			.notebook(f.notebookId)
			.version(source.current_version_id!);
		const before = await f.notebooks.beginSessionCapture(f.projectId, f.notebookId);
		await f.bucket.delete(version.capture(before.versions[0].html_snapshot!.capture_id!).html);
		f.read.mockClear();
		await f.capture();
		expect(f.read).not.toHaveBeenCalled();
		const current = await f.notebooks.beginSessionCapture(f.projectId, f.notebookId);
		expect(
			await (await f.bucket.get(
				version.capture(current.versions[0].html_snapshot!.capture_id!).html,
			))!.text(),
		).toBe('<p>result</p>');
		expect(current.versions[0].html_snapshot).toMatchObject({
			captured_at: expect.any(String),
			size_bytes: new TextEncoder().encode('<p>result</p>').byteLength,
		});
		expect(
			(await f.notebooks.getNotebook(f.projectId, f.notebookId)).source.current_version_id,
		).toBe(source.current_version_id);
	});

	it.each(['changed', 'deleted', 'probe-failed', 'optional-appeared'] as const)(
		'revalidates cached source after the initial probe (%s)',
		async (race) => {
			const f = await fixture();
			await f.capture();
			const initial = await f.fingerprints();
			f.probe.mockImplementationOnce(async () => {
				if (race === 'changed') await f.change('code', 'edited after probe');
				if (race === 'optional-appeared') await f.change('deps', '[project]');
				if (race === 'deleted') {
					delete f.files[f.paths.code];
					f.read.mockResolvedValueOnce(readFileFailure('NOT_FOUND'));
				}
				return execResult(true, JSON.stringify(initial), '');
			});
			if (race === 'probe-failed')
				f.probe.mockResolvedValueOnce(execResult(false, '', 'unavailable'));
			f.commit.mockClear();
			if (race === 'deleted') {
				await expect(f.capture()).rejects.toThrow('source is missing');
				expect(f.commit).not.toHaveBeenCalled();
				return;
			}
			await f.capture();
			expect(f.commit.mock.calls[0][2].code).toBe(
				race === 'changed' ? 'edited after probe' : 'edited',
			);
			if (race === 'optional-appeared') expect(f.commit.mock.calls[0][2].deps).toBe('[project]');
		},
	);

	it('does not skip the commit when another save advances the source head', async () => {
		const f = await fixture();
		await f.capture();
		await f.notebooks.commitSession(f.projectId, f.notebookId, { code: 'another save' }, ACTOR);
		f.commit.mockClear();
		f.read.mockClear();
		await f.capture();
		expect(f.read).not.toHaveBeenCalled();
		expect(f.commit).toHaveBeenCalledExactlyOnceWith(
			f.projectId,
			f.notebookId,
			expect.objectContaining({ code: 'edited' }),
			ACTOR,
			expect.objectContaining({ projectId: f.projectId, notebookId: f.notebookId }),
		);
	});

	it('does not let cached artifacts bypass notebook deletion', async () => {
		const f = await fixture();
		await f.capture();
		await f.notebooks.deleteNotebook(f.projectId, f.notebookId, ACTOR);
		f.commit.mockClear();
		await expect(f.capture()).rejects.toThrow('no longer accepts');
		expect(f.commit).toHaveBeenCalledOnce();
		expect(await f.commit.mock.results[0].value).toBeNull();
	});

	it('reads only changed files and supplies the unchanged source to commit', async () => {
		const f = await fixture();
		await f.capture();
		f.read.mockClear();
		f.commit.mockClear();
		await f.change('html', '<p>new result</p>');
		await f.capture();
		expect(f.read.mock.calls.map(([path]) => path)).toEqual([f.paths.html]);
		expect(f.commit.mock.calls[0][2]).toMatchObject({ code: 'edited', html: '<p>new result</p>' });
	});

	it('does not cache a failed commit or a probe/read race', async () => {
		const f = await fixture();
		f.commit.mockRejectedValueOnce(new Error('write failed'));
		await expect(f.capture()).rejects.toThrow('write failed');
		f.read.mockClear();
		await f.capture();
		expect(f.read).toHaveBeenCalledTimes(2);
		await f.change('code', 'new code');
		const oldProbe = await f.fingerprints();
		f.probe.mockImplementationOnce(async () => {
			await f.change('code', 'changed during read');
			return execResult(true, JSON.stringify(oldProbe), '');
		});
		await f.capture();
		f.read.mockClear();
		await f.capture();
		expect(f.read.mock.calls.some(([path]) => path === f.paths.code)).toBe(true);
	});

	it('falls back on malformed probes and propagates unreadable source errors', async () => {
		const f = await fixture();
		await f.capture();
		f.probe.mockResolvedValueOnce(execResult(true, 'invalid JSON', ''));
		f.read.mockImplementationOnce(async () => readFileFailure('READ_FAILED'));
		await expect(f.capture()).rejects.toMatchObject({ code: 'READ_FAILED' });
		await f.capture();
	});

	it('does not bypass symlink rejection after a failed probe', async () => {
		const f = await fixture();
		await f.capture();
		f.probe.mockResolvedValueOnce(execResult(false, '', 'symlink'));
		f.read.mockResolvedValueOnce({
			success: false,
			content: '',
			error: { code: 'READ_FAILED', reason: 'SYMLINK' },
		});
		await expect(f.capture()).rejects.toMatchObject({ code: 'READ_FAILED', reason: 'SYMLINK' });
	});

	it('does not reuse cached source when the source disappears', async () => {
		const f = await fixture();
		await f.capture();
		delete f.files[f.paths.code];
		f.read.mockResolvedValueOnce(readFileFailure('NOT_FOUND'));
		f.commit.mockClear();
		await expect(f.capture()).rejects.toThrow('source is missing');
		expect(f.commit).not.toHaveBeenCalled();
	});
});

describe('artifact cache bounds', () => {
	async function entry(code: string): Promise<CachedSessionArtifacts> {
		return {
			artifacts: { code },
			fingerprints: {
				code: { size: new TextEncoder().encode(code).byteLength, sha256: await sha256Hex(code) },
				deps: null,
				html: null,
				session: null,
			},
		};
	}
	it('evicts by byte budget and count, and isolates returned values', async () => {
		const cache = new SessionArtifactCache(2, 2056);
		await cache.remember('a', await entry('a'));
		await cache.remember('b', await entry('b'));
		cache.get('a')!.artifacts.code = 'mutated';
		await cache.remember('c', await entry('c'));
		expect(cache.get('b')).toBeUndefined();
		expect(cache.get('a')!.artifacts.code).toBe('a');
		await cache.remember('large', await entry('x'.repeat(2000)));
		expect(cache.get('large')).toBeUndefined();
		expect(cache.get('a')).toBeDefined();
	});
	it.each(['{}', '{"code":{"size":-1,"sha256":"bad"}}'])(
		'rejects invalid probe output %s',
		async (stdout) => {
			const { instance } = makeFsSandbox();
			vi.spyOn(instance, 'exec').mockResolvedValue(execResult(true, stdout, ''));
			expect(await probeSessionArtifacts(instance, '/workspace', 'notebook.py')).toBeUndefined();
		},
	);
});
