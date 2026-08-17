import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_REQUEST_BYTES } from '../../constants';
import { createNotebookId, createProjectId, createProposalId, createVersionId } from '../../ids';
import type { NotebookId, ProjectId, ProposalId, UserId, VersionId } from '../../ids';
import { paths } from '../../paths';
import type { Bucket, BucketPutOptions } from '../../ports/bucket';
import { listFilesFailure, readFileFailure } from '../../ports/sandbox';
import type { OpenChangeRequestResult, SourceControlPublisher } from '../../ports/sourceControl';
import type { SandboxInstance } from '../../ports/sandbox';
import type { Session } from '../../schema';
import { ACTOR, makeFsSandbox, makeSession, setupTestEnv, uid } from '../../testing';
import {
	DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS,
	DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS,
	NotebookProposalService,
} from './NotebookProposalService';
import { MAX_VERSIONS } from './NotebookService';

const encode = (value: string) => new TextEncoder().encode(value);

describe('NotebookProposalService', () => {
	let env: Awaited<ReturnType<typeof setupTestEnv>>;
	let projectId: ProjectId;
	let notebookId: NotebookId;
	let versionId: VersionId;
	let session: Session;

	beforeEach(async () => {
		env = await setupTestEnv();
		const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		projectId = project.id;
		const created = await env.notebooks.synced.create(
			projectId,
			{
				title: 'Synced',
				description: 'from git',
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
			},
			ACTOR,
		);
		notebookId = created.meta.id;
		await env.notebooks.synced.sync(projectId, notebookId, {
			repo: 'owner/repo',
			branch: 'main',
			root_path: 'apps',
			commit: 'abc123',
			files: [{ path: 'dashboard.py', bytes: encode('print("before")') }],
		});
		const detail = await env.notebooks.getNotebook(projectId, notebookId);
		if (detail.source.type !== 'git' || !detail.source.current_version_id) {
			throw new Error('expected synced source');
		}
		versionId = detail.source.current_version_id;
		session = makeSession({
			project_id: projectId,
			notebook_id: notebookId,
			source_version_id: versionId,
		});
	});

	function capture(
		sandbox: SandboxInstance,
		overrides: Partial<{
			proposalId: ProposalId;
			session: Session;
			author: UserId;
		}> = {},
	) {
		return env.proposals.captureEntryNotebook({
			projectId,
			notebookId,
			session: overrides.session ?? session,
			sandbox,
			workdir: '/workspace',
			author: overrides.author ?? ACTOR,
			proposalId: overrides.proposalId,
		});
	}

	function proxyBucket(
		put: (
			key: string,
			value: string | Uint8Array,
			options?: BucketPutOptions,
		) => ReturnType<Bucket['put']>,
		deleteObject: Bucket['delete'] = (key) => env.bucket.delete(key),
		getObject: Bucket['get'] = (key) => env.bucket.get(key),
	): Bucket {
		return {
			get: getObject,
			head: (key) => env.bucket.head(key),
			put,
			delete: deleteObject,
			list: (options) => env.bucket.list(options),
		};
	}

	function captureWith(
		service: NotebookProposalService,
		sandbox: SandboxInstance,
		proposalId: ProposalId,
	) {
		return service.captureEntryNotebook({
			projectId,
			notebookId,
			proposalId,
			session,
			sandbox,
			workdir: '/workspace',
			author: ACTOR,
		});
	}

	it('captures the changed entry notebook with its immutable git provenance', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'print("after")' } });
		const proposal = await capture(instance);

		expect(proposal).toMatchObject({
			notebook_id: notebookId,
			base_version_id: versionId,
			source: {
				provider: 'github',
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
				commit: 'abc123',
			},
			changes: [{ path: 'dashboard.py', operation: 'modify', size_bytes: 14 }],
		});
		expect(
			(await env.proposals.getProposal(projectId, notebookId, proposal.proposal_id)).publication,
		).toEqual(expect.objectContaining({ state: 'pending' }));
	});

	it('does not create a proposal for unchanged content', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'print("before")' } });
		await expect(capture(instance)).rejects.toThrow('no changes');
	});

	it('enforces the byte limit after reading content from the sandbox', async () => {
		const { instance } = makeFsSandbox({
			files: { 'dashboard.py': new Uint8Array(MAX_REQUEST_BYTES + 1) },
			sizes: { 'dashboard.py': 1 },
		});
		await expect(capture(instance)).rejects.toThrow(`exceeds the ${MAX_REQUEST_BYTES}-byte limit`);
	});

	it('publishes a repo-relative change and returns the stored PR on retry', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'print("after")' } });
		const proposal = await capture(instance);
		const openChangeRequest = vi.fn(async () => ({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch: `marimohub/${notebookId}/${proposal.proposal_id}`,
			headCommit: 'def456',
		}));
		const publisher: SourceControlPublisher = { provider: 'github', openChangeRequest };
		const input = {
			projectId,
			notebookId,
			proposalId: proposal.proposal_id as ProposalId,
			publisher,
			title: 'Update dashboard',
			body: 'Created by marimohub',
		};

		const first = await env.proposals.publishChangeRequest(input);
		const second = await env.proposals.publishChangeRequest(input);

		expect(second).toEqual(first);
		expect(openChangeRequest).toHaveBeenCalledOnce();
		expect(openChangeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				repository: 'owner/repo',
				baseBranch: 'main',
				baseCommit: 'abc123',
				draft: true,
				changes: [expect.objectContaining({ path: 'apps/dashboard.py', operation: 'modify' })],
			}),
		);
	});

	it.each([
		['another project', () => ({ project_id: createProjectId() })],
		['another notebook', () => ({ notebook_id: createNotebookId() })],
		['a stopped session', () => ({ status: 'terminated' as const })],
		['an app session', () => ({ mode: 'app' as const })],
		['an ephemeral session', () => ({ ephemeral: true })],
	])('rejects %s before inspecting the sandbox', async (_label, sessionOverrides) => {
		const { instance, calls } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		await expect(
			capture(instance, { session: { ...session, ...sessionOverrides() } }),
		).rejects.toThrow('running persistent editor session');
		expect(calls.readFile).toHaveLength(0);
	});

	it('rejects a session without a source version', async () => {
		const { instance, calls } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		await expect(
			capture(instance, { session: { ...session, source_version_id: undefined } }),
		).rejects.toThrow('no synced source revision');
		expect(calls.readFile).toHaveLength(0);
	});

	it('rejects a source version that does not exist', async () => {
		const { instance, calls } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		await expect(
			capture(instance, {
				session: { ...session, source_version_id: createVersionId() },
			}),
		).rejects.toThrow('not found');
		expect(calls.readFile).toHaveLength(0);
	});

	it('maps a sandbox listing failure to a safe conflict', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const sandbox = { ...instance, listFiles: async () => listFilesFailure('BACKEND_ERROR') };
		await expect(capture(sandbox)).rejects.toThrow('Could not inspect');
	});

	it('rejects a missing entry notebook', async () => {
		const { instance } = makeFsSandbox({ files: { 'other.py': 'changed' } });
		await expect(capture(instance)).rejects.toThrow('missing from the session');
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
		'rejects invalid listed file size %s',
		async (size) => {
			const { instance, calls } = makeFsSandbox({
				files: { 'dashboard.py': 'changed' },
				sizes: { 'dashboard.py': size },
			});
			await expect(capture(instance)).rejects.toThrow('invalid file metadata');
			expect(calls.readFile).toHaveLength(0);
		},
	);

	it('rejects an oversized listing without buffering the file', async () => {
		const { instance, calls } = makeFsSandbox({
			files: { 'dashboard.py': 'changed' },
			sizes: { 'dashboard.py': MAX_REQUEST_BYTES + 1 },
		});
		await expect(capture(instance)).rejects.toThrow('exceeds');
		expect(calls.readFile).toHaveLength(0);
	});

	it('maps a sandbox read failure to a safe conflict', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const sandbox = { ...instance, readFile: async () => readFileFailure('BACKEND_ERROR') };
		await expect(capture(sandbox)).rejects.toThrow('Could not read');
	});

	it.each([
		['an unknown encoding', { content: 'changed', encoding: 'utf-16' }],
		['invalid base64', { content: '%not-base64%', encoding: 'base64' }],
	])('rejects %s returned by the sandbox', async (_label, readResult) => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const sandbox: SandboxInstance = {
			...instance,
			readFile: async () =>
				({ success: true, ...readResult }) as Awaited<ReturnType<SandboxInstance['readFile']>>,
		};
		await expect(capture(sandbox)).rejects.toThrow(/invalid (encoding|base64 content)/);
	});

	it('returns an existing proposal without touching the sandbox', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const first = await capture(instance, { proposalId });
		const unreachable: SandboxInstance = {
			...instance,
			listFiles: async () => {
				throw new Error('must not list');
			},
		};
		await expect(capture(unreachable, { proposalId })).resolves.toEqual(first);
	});

	it('concurrent first-use captures reuse immutable objects without cleanup', async () => {
		const proposalId = createProposalId();
		const puts: { key: string; options?: BucketPutOptions }[] = [];
		const deleteObject = vi.fn<Bucket['delete']>((key) => env.bucket.delete(key));
		const bucket = proxyBucket(async (key, value, options) => {
			puts.push({ key, options });
			return env.bucket.put(key, value, options);
		}, deleteObject);
		const service = new NotebookProposalService(bucket);
		const first = makeFsSandbox({ files: { 'dashboard.py': 'concurrent change' } }).instance;
		const second = makeFsSandbox({ files: { 'dashboard.py': 'concurrent change' } }).instance;

		const [left, right] = await Promise.all([
			captureWith(service, first, proposalId),
			captureWith(service, second, proposalId),
		]);

		expect(right).toEqual(left);
		expect(puts.filter(({ key }) => key.includes(`/proposals/${proposalId}/`))).not.toHaveLength(0);
		expect(
			puts
				.filter(({ key }) => key.includes(`/proposals/${proposalId}/`))
				.every(({ options }) => options?.onlyIfNotExists === true),
		).toBe(true);
		const markerPuts = puts.filter(
			({ key }) => key === paths.proposalPayloadMarker(projectId, notebookId, proposalId),
		);
		expect(markerPuts).not.toHaveLength(0);
		expect(markerPuts.every(({ options }) => options?.onlyIfNotExists === true)).toBe(true);
		expect(deleteObject).not.toHaveBeenCalled();
	});

	it('never resets a publication completed during a capture retry', async () => {
		const proposalId = createProposalId();
		const sandbox = makeFsSandbox({ files: { 'dashboard.py': 'published change' } }).instance;
		const proposal = await capture(sandbox, { proposalId });
		const openChangeRequest = vi.fn(async () => ({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch: `marimohub/${notebookId}/${proposalId}`,
			headCommit: 'published-head',
		}));
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId,
			publisher: { provider: 'github', openChangeRequest },
			title: 'Update',
			body: '',
		});

		const publicationPath = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(proposalId).publication;
		let hidePublishedStateOnce = true;
		const bucket = proxyBucket(
			(key, value, options) => env.bucket.put(key, value, options),
			(key) => env.bucket.delete(key),
			async (key) => {
				if (key === publicationPath && hidePublishedStateOnce) {
					hidePublishedStateOnce = false;
					return null;
				}
				return env.bucket.get(key);
			},
		);

		await expect(
			captureWith(new NotebookProposalService(bucket), sandbox, proposalId),
		).resolves.toEqual(proposal);
		expect(
			(await env.proposals.getProposal(projectId, notebookId, proposalId)).publication,
		).toMatchObject({ state: 'published', change_request: { head_commit: 'published-head' } });
		expect(openChangeRequest).toHaveBeenCalledOnce();
	});

	it('repairs an interrupted capture without deleting its immutable manifest', async () => {
		const proposalId = createProposalId();
		const proposalPaths = paths.project(projectId).notebook(notebookId).proposal(proposalId);
		let failContentWrite = true;
		const deleteObject = vi.fn<Bucket['delete']>((key) => env.bucket.delete(key));
		const bucket = proxyBucket(async (key, value, options) => {
			if (key === proposalPaths.change(0) && failContentWrite) {
				failContentWrite = false;
				throw new Error('temporary storage failure');
			}
			return env.bucket.put(key, value, options);
		}, deleteObject);
		const service = new NotebookProposalService(bucket);
		const sandbox = makeFsSandbox({ files: { 'dashboard.py': 'repairable change' } }).instance;

		await expect(captureWith(service, sandbox, proposalId)).rejects.toThrow(
			'temporary storage failure',
		);
		expect(await env.bucket.head(proposalPaths.meta)).not.toBeNull();
		expect(await env.bucket.head(proposalPaths.publication)).toBeNull();
		expect(deleteObject).not.toHaveBeenCalled();

		await expect(captureWith(service, sandbox, proposalId)).resolves.toMatchObject({
			proposal_id: proposalId,
		});
		expect(await env.bucket.head(proposalPaths.change(0))).not.toBeNull();
		expect(await env.bucket.head(proposalPaths.publication)).not.toBeNull();
	});

	it('does not overwrite an interrupted capture with different session content', async () => {
		const proposalId = createProposalId();
		const proposalPaths = paths.project(projectId).notebook(notebookId).proposal(proposalId);
		let failContentWrite = true;
		const bucket = proxyBucket(async (key, value, options) => {
			if (key === proposalPaths.change(0) && failContentWrite) {
				failContentWrite = false;
				throw new Error('temporary storage failure');
			}
			return env.bucket.put(key, value, options);
		});
		const service = new NotebookProposalService(bucket);
		const original = makeFsSandbox({ files: { 'dashboard.py': 'first change' } }).instance;
		const different = makeFsSandbox({ files: { 'dashboard.py': 'second change' } }).instance;

		await expect(captureWith(service, original, proposalId)).rejects.toThrow();
		const manifestBefore = await (await env.bucket.get(proposalPaths.meta))?.text();
		await expect(captureWith(service, different, proposalId)).rejects.toThrow(
			'already capturing different notebook content',
		);
		expect(await (await env.bucket.get(proposalPaths.meta))?.text()).toBe(manifestBefore);
		expect(await env.bucket.head(proposalPaths.change(0))).toBeNull();
		expect(await env.bucket.head(proposalPaths.publication)).toBeNull();
	});

	it('rejects reuse of a proposal id by another author', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		await capture(instance, { proposalId });
		await expect(capture(instance, { proposalId, author: uid('another-author') })).rejects.toThrow(
			'different proposal',
		);
	});

	it('rejects reuse of a proposal id for another source revision', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		await capture(instance, { proposalId });
		await expect(
			capture(instance, {
				proposalId,
				session: { ...session, source_version_id: createVersionId() },
			}),
		).rejects.toThrow('different source revision');
	});

	it('reports a missing proposal consistently', async () => {
		await expect(
			env.proposals.getProposal(projectId, notebookId, createProposalId()),
		).rejects.toThrow('not found');
	});

	it('reuses only proposals whose captured payload is complete', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance, { proposalId });
		const changePath = paths.project(projectId).notebook(notebookId).proposal(proposalId).change(0);

		await expect(
			env.proposals.getReusableProposal(projectId, notebookId, proposalId),
		).resolves.toEqual(proposal);
		await env.bucket.delete(changePath);
		await expect(
			env.proposals.getReusableProposal(projectId, notebookId, proposalId),
		).resolves.toBeUndefined();
	});

	it('resolves repository coordinates for a version written before git_source was stored', async () => {
		const versionPath = paths.project(projectId).notebook(notebookId).version(versionId).meta;
		const object = await env.bucket.get(versionPath);
		if (!object) throw new Error('expected version');
		const { git_source: _gitSource, ...legacyVersion } =
			await object.json<Record<string, unknown>>();
		await env.bucket.put(versionPath, JSON.stringify(legacyVersion));
		const legacySource = {
			provider: 'github',
			repo: 'owner/repo',
			branch: 'main',
			root_path: 'apps',
			entry_notebook: 'dashboard.py',
			commit: 'abc123',
		};

		await expect(
			env.proposals.resolveSourceRevision(projectId, notebookId, versionId, legacySource),
		).resolves.toEqual(legacySource);
	});

	it('explains how to recover when a legacy version has no repository provenance', async () => {
		const versionPath = paths.project(projectId).notebook(notebookId).version(versionId).meta;
		const object = await env.bucket.get(versionPath);
		if (!object) throw new Error('expected version');
		const { git_source: _gitSource, ...legacyVersion } =
			await object.json<Record<string, unknown>>();
		await env.bucket.put(versionPath, JSON.stringify(legacyVersion));

		await expect(
			env.proposals.resolveSourceRevision(projectId, notebookId, versionId),
		).rejects.toThrow('restart from the latest synced version');
	});

	it('rejects legacy repository coordinates for a different commit', async () => {
		const versionPath = paths.project(projectId).notebook(notebookId).version(versionId).meta;
		const object = await env.bucket.get(versionPath);
		if (!object) throw new Error('expected version');
		const { git_source: _gitSource, ...legacyVersion } =
			await object.json<Record<string, unknown>>();
		await env.bucket.put(versionPath, JSON.stringify(legacyVersion));

		await expect(
			env.proposals.resolveSourceRevision(projectId, notebookId, versionId, {
				provider: 'github',
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
				commit: 'different-commit',
			}),
		).rejects.toThrow('missing repository coordinates');
	});

	it('rejects outbound publishing when the synced repository provider is unknown', async () => {
		const versionPath = paths.project(projectId).notebook(notebookId).version(versionId).meta;
		const object = await env.bucket.get(versionPath);
		if (!object) throw new Error('expected version');
		const version = await object.json<Record<string, unknown>>();
		version.git_source = {
			provider: null,
			repo: 'https://code.example.org/team/repo',
			branch: 'main',
			root_path: 'apps',
			entry_notebook: 'dashboard.py',
			commit: 'abc123',
		};
		await env.bucket.put(versionPath, JSON.stringify(version));
		const { instance, calls } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });

		await expect(capture(instance)).rejects.toThrow('no recognized source-control provider');
		expect(calls.readFile).toHaveLength(0);
	});

	it('rejects a publisher for a different provider before reading change bytes', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance);
		const publisher: SourceControlPublisher = {
			provider: 'gitlab',
			openChangeRequest: vi.fn(),
		};
		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: proposal.proposal_id,
				publisher,
				title: 'Update',
				body: '',
			}),
		).rejects.toThrow('No publisher');
		expect(publisher.openChangeRequest).not.toHaveBeenCalled();
	});

	it('does not call the provider when proposal content is missing', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance);
		await env.bucket.delete(
			paths.project(projectId).notebook(notebookId).proposal(proposal.proposal_id).change(0),
		);
		const openChangeRequest = vi.fn<SourceControlPublisher['openChangeRequest']>();
		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: proposal.proposal_id,
				publisher: { provider: 'github', openChangeRequest },
				title: 'Update',
				body: '',
			}),
		).rejects.toThrow('change 0 not found');
		expect(openChangeRequest).not.toHaveBeenCalled();

		await expect(capture(instance, { proposalId: proposal.proposal_id })).resolves.toEqual(
			proposal,
		);
		expect(
			await env.bucket.head(
				paths.project(projectId).notebook(notebookId).proposal(proposal.proposal_id).change(0),
			),
		).not.toBeNull();
	});

	it('retains a synced source revision referenced by a persistent session', async () => {
		const liveSession = await env.sessions.createSession({
			project_id: projectId,
			notebook_id: notebookId,
			user_id: ACTOR,
			source_version_id: versionId,
		});
		for (let i = 0; i <= MAX_VERSIONS; i++) {
			await env.notebooks.synced.sync(projectId, notebookId, {
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'apps',
				commit: `later-${i}`,
				files: [{ path: 'dashboard.py', bytes: encode(`print(${i})`) }],
			});
		}

		await expect(
			env.proposals.resolveSourceRevision(projectId, notebookId, versionId),
		).resolves.toMatchObject({ commit: 'abc123', provider: 'github' });
		await env.sessions.markFailed(projectId, liveSession.session_id);
		await env.notebooks.synced.sync(projectId, notebookId, {
			repo: 'owner/repo',
			branch: 'main',
			root_path: 'apps',
			commit: 'after-session',
			files: [{ path: 'dashboard.py', bytes: encode('print("done")') }],
		});
		await expect(
			env.proposals.resolveSourceRevision(projectId, notebookId, versionId),
		).rejects.toThrow('not found');
	});

	it('does not publish corrupted proposal content', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance);
		await env.bucket.put(
			paths.project(projectId).notebook(notebookId).proposal(proposal.proposal_id).change(0),
			'corrupted',
		);
		const openChangeRequest = vi.fn<SourceControlPublisher['openChangeRequest']>();
		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: proposal.proposal_id,
				publisher: { provider: 'github', openChangeRequest },
				title: 'Update',
				body: '',
			}),
		).rejects.toThrow('integrity check');
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it.each([
		['a non-positive number', { number: 0 }],
		['an insecure URL', { url: 'http://github.com/owner/repo/pull/1' }],
		['an empty commit', { headCommit: '' }],
		['a different branch', { headBranch: 'someone/else' }],
	])('does not persist %s returned by a provider', async (_label, invalid) => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance);
		const expectedBranch = `marimohub/${notebookId}/${proposal.proposal_id}`;
		const result = {
			number: 1,
			url: 'https://github.com/owner/repo/pull/1',
			headBranch: expectedBranch,
			headCommit: 'head-sha',
			...invalid,
		} as OpenChangeRequestResult;
		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: proposal.proposal_id,
				publisher: { provider: 'github', openChangeRequest: async () => result },
				title: 'Update',
				body: '',
			}),
		).rejects.toThrow('invalid change request');
		expect(
			(await env.proposals.getProposal(projectId, notebookId, proposal.proposal_id)).publication,
		).toMatchObject({ state: 'pending' });
	});

	it('leaves the proposal pending when the provider is unavailable', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance);
		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: proposal.proposal_id,
				publisher: {
					provider: 'github',
					openChangeRequest: async () => {
						throw new Error('provider secret');
					},
				},
				title: 'Update',
				body: '',
			}),
		).rejects.toThrow('provider secret');
		expect(
			(await env.proposals.getProposal(projectId, notebookId, proposal.proposal_id)).publication,
		).toMatchObject({ state: 'pending' });
	});

	it('prunes expired change bytes but retains proposal audit metadata', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'retained metadata' } });
		const proposal = await capture(instance, { proposalId });
		const proposalPaths = paths.project(projectId).notebook(notebookId).proposal(proposalId);
		const markerPath = paths.proposalPayloadMarker(projectId, notebookId, proposalId);
		const expiresAt = Date.parse(proposal.created_at) + DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS;
		const sweepAt = expiresAt + DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS;

		expect(await env.proposals.pruneExpiredPayloads({ nowMs: sweepAt - 1 })).toBe(0);
		expect(await env.bucket.head(proposalPaths.change(0))).not.toBeNull();

		const originalList = env.bucket.list.bind(env.bucket);
		env.bucket.list = (options) => originalList({ ...options, limit: 1 });
		try {
			expect(await env.proposals.pruneExpiredPayloads({ nowMs: sweepAt })).toBe(1);
		} finally {
			env.bucket.list = originalList;
		}
		expect(await env.bucket.head(proposalPaths.change(0))).toBeNull();
		expect(await env.bucket.head(markerPath)).toBeNull();
		expect(await env.bucket.head(proposalPaths.meta)).not.toBeNull();
		expect(await env.bucket.head(proposalPaths.publication)).not.toBeNull();
	});

	it('skips malformed retention markers without blocking valid payload pruning', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'expires' } });
		const proposal = await capture(instance, { proposalId });
		const invalidMarker = `${paths.proposalPayloadMarkersPrefix}invalid.json`;
		await env.bucket.put(invalidMarker, '{not json');

		const now =
			Date.parse(proposal.created_at) +
			DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS +
			DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS;
		expect(await env.proposals.pruneExpiredPayloads({ nowMs: now })).toBe(1);
		expect(await env.bucket.head(invalidMarker)).not.toBeNull();
	});

	it('keeps the retention marker when deleting proposal content fails', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'retry cleanup' } });
		const proposal = await capture(instance, { proposalId });
		const proposalPaths = paths.project(projectId).notebook(notebookId).proposal(proposalId);
		const markerPath = paths.proposalPayloadMarker(projectId, notebookId, proposalId);
		const bucket = proxyBucket(
			(key, value, options) => env.bucket.put(key, value, options),
			async (key) => {
				if (
					(typeof key === 'string' && key === proposalPaths.change(0)) ||
					(Array.isArray(key) && key.includes(proposalPaths.change(0)))
				) {
					throw new Error('temporary delete failure');
				}
				return env.bucket.delete(key);
			},
		);
		const service = new NotebookProposalService(bucket);
		const now =
			Date.parse(proposal.created_at) +
			DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS +
			DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS;

		expect(await service.pruneExpiredPayloads({ nowMs: now })).toBe(0);
		expect(await env.bucket.head(proposalPaths.change(0))).not.toBeNull();
		expect(await env.bucket.head(markerPath)).not.toBeNull();
	});

	it('rejects expired proposal payloads before inspecting the sandbox or calling a provider', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'expires' } });
		const proposal = await capture(instance, { proposalId });
		vi.useFakeTimers();
		vi.setSystemTime(Date.parse(proposal.created_at) + DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS);
		try {
			await expect(
				env.proposals.getReusableProposal(projectId, notebookId, proposalId),
			).rejects.toMatchObject({
				code: 'PROPOSAL_RETRY_REQUIRED',
				message: expect.stringContaining('retry with a new idempotency key'),
			});
			const unreachable = makeFsSandbox({ files: { 'dashboard.py': 'unused' } });
			await expect(capture(unreachable.instance, { proposalId })).rejects.toMatchObject({
				code: 'PROPOSAL_RETRY_REQUIRED',
				message: expect.stringContaining('retry with a new idempotency key'),
			});
			expect(unreachable.calls.readFile).toHaveLength(0);

			const openChangeRequest = vi.fn<SourceControlPublisher['openChangeRequest']>();
			await expect(
				env.proposals.publishChangeRequest({
					projectId,
					notebookId,
					proposalId,
					publisher: { provider: 'github', openChangeRequest },
					title: 'Update',
					body: '',
				}),
			).rejects.toMatchObject({
				code: 'PROPOSAL_RETRY_REQUIRED',
				message: expect.stringContaining('payload expired'),
			});
			expect(openChangeRequest).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects a non-finite maintenance clock without scanning storage', async () => {
		const list = vi.spyOn(env.bucket, 'list');
		await expect(env.proposals.pruneExpiredPayloads({ nowMs: Number.NaN })).rejects.toThrow(
			'nowMs must be finite',
		);
		expect(list).not.toHaveBeenCalled();
	});
});
