import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createProposalId,
	createSandboxId,
	MAX_VERSIONS,
	paths,
	UnavailableError,
} from '@marimo-hub/core';
import type {
	ProposalId,
	SourceControlPublisher,
	SourceControlRegistry,
	VersionId,
} from '@marimo-hub/core';
import { ACTOR, fakeComputeFrom, makeFsSandbox, uid } from '@marimo-hub/core/testing';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	stubSourceControl,
} from '../testing';

const encode = (value: string) => new TextEncoder().encode(value);

describe('change request routes', () => {
	let setup: Awaited<ReturnType<typeof createTestApi>>;
	let projectId: Awaited<ReturnType<typeof setup.deps.services.projects.createProject>>['id'];
	let notebookId: Awaited<
		ReturnType<typeof setup.deps.services.notebooks.synced.create>
	>['meta']['id'];
	let sessionId: Awaited<
		ReturnType<typeof setup.deps.services.sessions.createSession>
	>['session_id'];
	let sourceVersionId: VersionId;
	let openChangeRequest: ReturnType<typeof vi.fn<SourceControlPublisher['openChangeRequest']>>;
	let updateChangeRequest: ReturnType<
		typeof vi.fn<NonNullable<SourceControlPublisher['updateChangeRequest']>>
	>;
	const route = () =>
		`/projects/${projectId}/notebooks/${notebookId}/sessions/${sessionId}/change-requests`;

	beforeEach(async () => {
		const bucket = await createInitializedBucket();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'print("after")' } });
		let nextPullRequestNumber = 17;
		openChangeRequest = vi.fn<SourceControlPublisher['openChangeRequest']>(async (input) => {
			const number = nextPullRequestNumber++;
			return {
				number,
				url: `https://github.com/owner/repo/pull/${number}`,
				headBranch: input.headBranch,
				headCommit: `created-${number}`,
			};
		});
		updateChangeRequest = vi.fn<NonNullable<SourceControlPublisher['updateChangeRequest']>>(
			async (input) => ({ ...input.changeRequest, headCommit: 'updated-head' }),
		);
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest,
			updateChangeRequest,
		};
		setup = createTestApi({
			bucket,
			compute: fakeComputeFrom(instance),
			deps: { sourceControl: stubSourceControl({ publisher }) },
		});
		const project = await setup.deps.services.projects.createProject(
			{ name: 'Dashboards', description: 'd' },
			ACTOR,
		);
		projectId = project.id;
		const created = await setup.deps.services.notebooks.synced.create(
			projectId,
			{
				title: 'Revenue dashboard',
				description: 'from git',
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
			},
			ACTOR,
		);
		notebookId = created.meta.id;
		await setup.deps.services.notebooks.synced.sync(projectId, notebookId, {
			repo: 'owner/repo',
			branch: 'main',
			root_path: 'apps',
			commit: 'abc123',
			files: [{ path: 'dashboard.py', bytes: encode('print("before")') }],
		});
		const detail = await setup.deps.services.notebooks.getNotebook(projectId, notebookId);
		if (detail.source.type !== 'git' || !detail.source.current_version_id) {
			throw new Error('Expected a synced source');
		}
		sourceVersionId = detail.source.current_version_id;
		const session = await setup.deps.services.sessions.createSession({
			project_id: projectId,
			notebook_id: notebookId,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
			source_version_id: sourceVersionId,
		});
		sessionId = session.session_id;
		await setup.deps.services.sessions.setRunning(projectId, sessionId, 'https://sandbox.example');
	});

	it('opens a draft change request from the exact session revision', async () => {
		const resolveSourceRevision = vi.spyOn(setup.deps.services.proposals, 'resolveSourceRevision');
		const data = await expectOk<{
			proposal_id: string;
			change_request: { provider: string; number: number; url: string };
		}>(
			await setup.request(
				'POST',
				`/projects/${projectId}/notebooks/${notebookId}/sessions/${sessionId}/change-requests`,
				{},
				{ 'Idempotency-Key': 'open-dashboard-pr' },
			),
			201,
		);

		expect(data.proposal_id).toMatch(/^prop-/);
		expect(data.change_request).toMatchObject({
			provider: 'github',
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
		});
		expect(openChangeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				repository: 'owner/repo',
				baseBranch: 'main',
				baseCommit: 'abc123',
				draft: true,
				coAuthor: {
					name: ACTOR,
					email: `${ACTOR}@example.com`,
				},
				changes: [expect.objectContaining({ path: 'apps/dashboard.py' })],
			}),
		);
		expect(resolveSourceRevision).toHaveBeenCalledOnce();

		await expectOk(
			await setup.request(
				'POST',
				`/projects/${projectId}/notebooks/${notebookId}/sessions/${sessionId}/change-requests`,
				{},
				{ 'Idempotency-Key': 'open-dashboard-pr' },
			),
			201,
		);
		expect(openChangeRequest).toHaveBeenCalledOnce();
	});

	it('replays a recorded response after the publisher is disabled', async () => {
		const headers = { 'Idempotency-Key': 'disabled-after-publish' };
		const first = await expectOk(await setup.request('POST', route(), {}, headers), 201);
		const getPublisher = vi.fn<SourceControlRegistry['getPublisher']>();
		const withoutPublisher = createTestApi({
			bucket: setup.bucket,
			compute: setup.deps.compute,
			deps: { sourceControl: { ...stubSourceControl(), getPublisher } },
		});

		const replay = await expectOk(
			await withoutPublisher.request('POST', route(), {}, headers),
			201,
		);

		expect(replay).toEqual(first);
		expect(getPublisher).not.toHaveBeenCalled();
		expect(openChangeRequest).toHaveBeenCalledOnce();
	});

	it('rejects a reusable proposal owned by another idempotency key', async () => {
		const first = await expectOk<{ proposal_id: ProposalId }>(
			await setup.request('POST', route(), {}, { 'Idempotency-Key': 'first-owner' }),
			201,
		);
		const record = await setup.deps.services.proposals.getReusableProposal(
			projectId,
			notebookId,
			first.proposal_id,
		);
		if (!record) throw new Error('Expected a reusable proposal');
		vi.spyOn(setup.deps.services.proposals, 'getReusableProposal').mockResolvedValue(record);

		await expectError(
			await setup.request('POST', route(), {}, { 'Idempotency-Key': 'different-owner' }),
			409,
			'CONFLICT',
		);
		expect(openChangeRequest).toHaveBeenCalledOnce();
	});

	it('preserves unexpected reusable-proposal lookup failures', async () => {
		vi.spyOn(setup.deps.services.proposals, 'getReusableProposal').mockRejectedValue(
			new UnavailableError('Proposal storage is unavailable'),
		);

		await expectError(
			await setup.request('POST', route(), {}, { 'Idempotency-Key': 'lookup-failure' }),
			503,
			'SERVICE_UNAVAILABLE',
		);
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it('updates an existing change request or explicitly creates a new one', async () => {
		const initial = await expectOk<{
			proposal_id: string;
			change_request: { number: number; url: string; head_branch: string };
		}>(
			await setup.request('POST', route(), {}, { 'Idempotency-Key': 'initial-change-request' }),
			201,
		);
		const updated = await expectOk<{
			proposal_id: string;
			change_request: { number: number; url: string; head_branch: string };
		}>(
			await setup.request(
				'POST',
				route(),
				{ target_proposal_id: initial.proposal_id },
				{ 'Idempotency-Key': 'update-change-request' },
			),
			201,
		);

		expect(updated.proposal_id).not.toBe(initial.proposal_id);
		expect(updated.change_request).toMatchObject({
			number: initial.change_request.number,
			url: initial.change_request.url,
			head_branch: initial.change_request.head_branch,
		});
		expect(updateChangeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				coAuthor: {
					name: ACTOR,
					email: `${ACTOR}@example.com`,
				},
			}),
		);
		expect(openChangeRequest).toHaveBeenCalledOnce();
		const storedUpdate = await setup.deps.services.proposals.getProposal(
			projectId,
			notebookId,
			updated.proposal_id as ProposalId,
		);
		expect(storedUpdate.proposal.target_proposal_id).toBe(initial.proposal_id);

		const created = await expectOk<{
			proposal_id: string;
			change_request: { number: number; url: string; head_branch: string };
		}>(
			await setup.request(
				'POST',
				route(),
				{},
				{ 'Idempotency-Key': 'create-another-change-request' },
			),
			201,
		);
		expect(created.change_request.number).toBe(18);
		expect(created.change_request.url).toBe('https://github.com/owner/repo/pull/18');
		expect(created.change_request.head_branch).not.toBe(initial.change_request.head_branch);
		expect(openChangeRequest).toHaveBeenCalledTimes(2);
		const events = await setup.deps.services.events.getEvents(
			new Date().toISOString().slice(0, 10),
		);
		expect(
			events
				.filter((event) => event.event.startsWith('notebook.change_request.'))
				.map((event) => event.event),
		).toEqual([
			'notebook.change_request.open',
			'notebook.change_request.update',
			'notebook.change_request.open',
		]);
	});

	it('recovers a published update when response recording fails and the publisher is disabled', async () => {
		const initial = await expectOk<{ proposal_id: string }>(
			await setup.request(
				'POST',
				route(),
				{},
				{ 'Idempotency-Key': 'initial-before-update-recovery' },
			),
			201,
		);
		vi.spyOn(setup.deps.services.idempotency, 'record').mockRejectedValueOnce(
			new Error('response record unavailable'),
		);
		const headers = { 'Idempotency-Key': 'update-response-record-failure' };
		const body = { target_proposal_id: initial.proposal_id };
		await expectError(await setup.request('POST', route(), body, headers), 500, 'INTERNAL_ERROR');
		expect(updateChangeRequest).toHaveBeenCalledOnce();

		const getPublisher = vi.fn<SourceControlRegistry['getPublisher']>();
		const withoutPublisher = createTestApi({
			bucket: setup.bucket,
			compute: setup.deps.compute,
			deps: { sourceControl: { ...stubSourceControl(), getPublisher } },
		});
		const replay = await expectOk<{ proposal_id: string; change_request: { number: number } }>(
			await withoutPublisher.request('POST', route(), body, headers),
			201,
		);

		expect(replay.proposal_id).not.toBe(initial.proposal_id);
		expect(replay.change_request.number).toBe(17);
		expect(getPublisher).not.toHaveBeenCalled();
		expect(updateChangeRequest).toHaveBeenCalledOnce();
	});

	it('rejects a missing update target without calling either provider operation', async () => {
		await expectError(
			await setup.request(
				'POST',
				route(),
				{ target_proposal_id: createProposalId() },
				{ 'Idempotency-Key': 'missing-update-target' },
			),
			404,
			'NOT_FOUND',
		);
		expect(openChangeRequest).not.toHaveBeenCalled();
		expect(updateChangeRequest).not.toHaveBeenCalled();
	});

	it('rejects an update target that has not been published', async () => {
		openChangeRequest.mockRejectedValueOnce(new UnavailableError('GitHub is unavailable'));
		const capture = vi.spyOn(setup.deps.services.proposals, 'captureProposal');
		await expectError(
			await setup.request('POST', route(), {}, { 'Idempotency-Key': 'pending-update-target' }),
			503,
			'SERVICE_UNAVAILABLE',
		);
		const captureResult = capture.mock.results[0];
		if (captureResult?.type !== 'return') throw new Error('Expected proposal capture');
		const target = await captureResult.value;

		await expectError(
			await setup.request(
				'POST',
				route(),
				{ target_proposal_id: target.proposal_id },
				{ 'Idempotency-Key': 'update-pending-target' },
			),
			409,
			'CONFLICT',
		);
		expect(openChangeRequest).toHaveBeenCalledOnce();
		expect(updateChangeRequest).not.toHaveBeenCalled();
	});

	it('recovers a published proposal when response recording failed and its publisher is disabled', async () => {
		const headers = { 'Idempotency-Key': 'disabled-before-response-recorded' };
		vi.spyOn(setup.deps.services.idempotency, 'record').mockRejectedValueOnce(
			new Error('response record unavailable'),
		);

		await expectError(await setup.request('POST', route(), {}, headers), 500, 'INTERNAL_ERROR');
		expect(openChangeRequest).toHaveBeenCalledOnce();

		const getPublisher = vi.fn<SourceControlRegistry['getPublisher']>();
		const withoutPublisher = createTestApi({
			bucket: setup.bucket,
			compute: setup.deps.compute,
			deps: { sourceControl: { ...stubSourceControl(), getPublisher } },
		});

		const replay = await expectOk<{
			proposal_id: string;
			change_request: { provider: string; number: number; url: string };
		}>(await withoutPublisher.request('POST', route(), {}, headers), 201);

		expect(replay.change_request).toMatchObject({
			provider: 'github',
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
		});
		expect(getPublisher).not.toHaveBeenCalled();
		expect(openChangeRequest).toHaveBeenCalledOnce();
	});

	it('replays a recorded response after its source version is pruned', async () => {
		const headers = { 'Idempotency-Key': 'version-pruned-after-publish' };
		const first = await expectOk(await setup.request('POST', route(), {}, headers), 201);
		await setup.deps.services.sessions.markFailed(projectId, sessionId, {
			code: 'TEST_COMPLETE',
			message: 'The original edit session ended',
		});
		for (let index = 0; index <= MAX_VERSIONS; index++) {
			await setup.deps.services.notebooks.synced.sync(projectId, notebookId, {
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'apps',
				commit: `later-${index}`,
				files: [{ path: 'dashboard.py', bytes: encode(`print(${index})`) }],
			});
		}

		const replay = await expectOk(await setup.request('POST', route(), {}, headers), 201);
		expect(replay).toEqual(first);
		expect(openChangeRequest).toHaveBeenCalledOnce();
		await expectError(
			await setup.request(
				'POST',
				route(),
				{},
				{ 'Idempotency-Key': 'version-pruned-new-operation' },
			),
			404,
			'NOT_FOUND',
		);
	});

	it('resumes the same proposal after a publication failure', async () => {
		openChangeRequest.mockRejectedValueOnce(new UnavailableError('GitHub is unavailable'));
		const path = `/projects/${projectId}/notebooks/${notebookId}/sessions/${sessionId}/change-requests`;
		const headers = { 'Idempotency-Key': 'retry-dashboard-pr' };

		await expectError(await setup.request('POST', path, {}, headers), 503, 'SERVICE_UNAVAILABLE');
		await expectOk(await setup.request('POST', path, {}, headers), 201);

		expect(openChangeRequest).toHaveBeenCalledTimes(2);
		expect(openChangeRequest.mock.calls[0]?.[0].headBranch).toBe(
			openChangeRequest.mock.calls[1]?.[0].headBranch,
		);
	});

	it('requires a configured publisher when resuming a pending proposal', async () => {
		openChangeRequest.mockRejectedValueOnce(new UnavailableError('GitHub is unavailable'));
		const headers = { 'Idempotency-Key': 'pending-without-publisher' };
		await expectError(
			await setup.request('POST', route(), {}, headers),
			503,
			'SERVICE_UNAVAILABLE',
		);

		const getPublisher = vi.fn<SourceControlRegistry['getPublisher']>();
		const withoutPublisher = createTestApi({
			bucket: setup.bucket,
			compute: setup.deps.compute,
			deps: { sourceControl: { ...stubSourceControl(), getPublisher } },
		});
		const capture = vi.spyOn(withoutPublisher.deps.services.proposals, 'captureProposal');

		await expectError(
			await withoutPublisher.request('POST', route(), {}, headers),
			503,
			'SERVICE_UNAVAILABLE',
		);

		expect(getPublisher).toHaveBeenCalledExactlyOnceWith('github');
		expect(capture).not.toHaveBeenCalled();
		expect(openChangeRequest).toHaveBeenCalledOnce();
	});

	it('finishes an incomplete proposal capture before retrying publication', async () => {
		openChangeRequest.mockRejectedValueOnce(new UnavailableError('GitHub is unavailable'));
		const capture = vi.spyOn(setup.deps.services.proposals, 'captureProposal');
		const headers = { 'Idempotency-Key': 'retry-incomplete-capture' };

		await expectError(
			await setup.request('POST', route(), {}, headers),
			503,
			'SERVICE_UNAVAILABLE',
		);
		const firstCapture = capture.mock.results[0];
		if (firstCapture?.type !== 'return') throw new Error('Expected proposal capture');
		const proposal = await firstCapture.value;
		const changePath = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(proposal.proposal_id)
			.change(0);
		await setup.bucket.delete(changePath);

		await expectOk(await setup.request('POST', route(), {}, headers), 201);
		expect(capture).toHaveBeenCalledTimes(2);
		expect(await setup.bucket.head(changePath)).not.toBeNull();
		expect(openChangeRequest).toHaveBeenCalledTimes(2);
	});

	it('resumes a captured proposal after its session and source version are removed', async () => {
		openChangeRequest.mockRejectedValueOnce(new UnavailableError('GitHub is unavailable'));
		const capture = vi.spyOn(setup.deps.services.proposals, 'captureProposal');
		const headers = { 'Idempotency-Key': 'retry-after-session-removal' };

		await expectError(
			await setup.request('POST', route(), {}, headers),
			503,
			'SERVICE_UNAVAILABLE',
		);
		await setup.deps.services.sessions.markFailed(projectId, sessionId, {
			code: 'TEST_COMPLETE',
			message: 'The original edit session ended',
		});
		await setup.bucket.delete(paths.session(projectId, sessionId));
		for (let index = 0; index <= MAX_VERSIONS; index++) {
			await setup.deps.services.notebooks.synced.sync(projectId, notebookId, {
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'apps',
				commit: `pending-retry-${index}`,
				files: [{ path: 'dashboard.py', bytes: encode(`print(${index})`) }],
			});
		}
		expect(
			await setup.bucket.get(
				paths.project(projectId).notebook(notebookId).version(sourceVersionId).meta,
			),
		).toBeNull();

		await expectOk(await setup.request('POST', route(), {}, headers), 201);
		expect(capture).toHaveBeenCalledOnce();
		expect(openChangeRequest).toHaveBeenCalledTimes(2);
		expect(openChangeRequest.mock.calls[1]?.[0]).toMatchObject({ baseCommit: 'abc123' });
	});

	it('does not infer provenance for a stale session created before provenance tracking', async () => {
		const versionPath = paths.project(projectId).notebook(notebookId).version(sourceVersionId).meta;
		const object = await setup.bucket.get(versionPath);
		if (!object) throw new Error('Expected the source version');
		const { git_source: _gitSource, ...legacyVersion } =
			await object.json<Record<string, unknown>>();
		await setup.bucket.put(versionPath, JSON.stringify(legacyVersion));
		await setup.deps.services.notebooks.synced.sync(projectId, notebookId, {
			repo: 'owner/repo',
			branch: 'main',
			root_path: 'apps',
			commit: 'newer-commit',
			files: [{ path: 'dashboard.py', bytes: encode('print("newer")') }],
		});

		const error = await expectError(
			await setup.request(
				'POST',
				route(),
				{},
				{ 'Idempotency-Key': 'stale-pre-provenance-session' },
			),
			409,
			'CONFLICT',
		);
		expect(error.message).toContain('restart from the latest synced version');
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it('requires project manager access', async () => {
		const outsider = createTestApi({
			bucket: setup.bucket,
			userId: uid('outsider'),
			compute: setup.deps.compute,
			deps: { sourceControl: setup.deps.sourceControl },
		});
		await expectError(
			await outsider.request(
				'POST',
				`/projects/${projectId}/notebooks/${notebookId}/sessions/${sessionId}/change-requests`,
				{},
				{ 'Idempotency-Key': 'forbidden-pr' },
			),
			403,
			'FORBIDDEN',
		);
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it('fails before capture when the provider is not configured', async () => {
		const withoutPublisher = createTestApi({
			bucket: setup.bucket,
			compute: setup.deps.compute,
		});
		const capture = vi.spyOn(withoutPublisher.deps.services.proposals, 'captureProposal');
		await expectError(
			await withoutPublisher.request(
				'POST',
				`/projects/${projectId}/notebooks/${notebookId}/sessions/${sessionId}/change-requests`,
				{},
				{ 'Idempotency-Key': 'unconfigured-pr' },
			),
			503,
			'SERVICE_UNAVAILABLE',
		);
		expect(capture).not.toHaveBeenCalled();
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it('requires an idempotency key for the external side effect', async () => {
		await expectError(
			await setup.request(
				'POST',
				`/projects/${projectId}/notebooks/${notebookId}/sessions/${sessionId}/change-requests`,
				{},
			),
			422,
			'VALIDATION_ERROR',
		);
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it.each([
		['a whitespace-only title', { title: '   ' }],
		['a title over 256 characters', { title: 'x'.repeat(257) }],
		['a body over 64 KiB', { body: 'x'.repeat(65_537) }],
		['a malformed target proposal id', { target_proposal_id: '../proposal' }],
	])('rejects %s before capture or provider access', async (_label, body) => {
		await expectError(
			await setup.request('POST', route(), body, { 'Idempotency-Key': 'invalid-body' }),
			422,
			'VALIDATION_ERROR',
		);
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it('rejects an oversized idempotency key before provider access', async () => {
		await expectError(
			await setup.request('POST', route(), {}, { 'Idempotency-Key': 'x'.repeat(256) }),
			422,
			'VALIDATION_ERROR',
		);
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it('rejects a local notebook before inspecting the git session', async () => {
		const local = await setup.deps.services.notebooks.createNotebook(
			projectId,
			{ title: 'Local', description: 'd', code: 'print(1)' },
			ACTOR,
		);
		await expectError(
			await setup.request(
				'POST',
				`/projects/${projectId}/notebooks/${local.id}/sessions/${sessionId}/change-requests`,
				{},
				{ 'Idempotency-Key': 'local-notebook' },
			),
			409,
			'CONFLICT',
		);
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it('rejects a session that is no longer running', async () => {
		await setup.deps.services.sessions.markFailed(projectId, sessionId, {
			code: 'TEST_FAILURE',
			message: 'stopped',
		});
		await expectError(
			await setup.request('POST', route(), {}, { 'Idempotency-Key': 'stopped-session' }),
			409,
			'CONFLICT',
		);
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it('rejects a session without a synced source revision', async () => {
		const session = await setup.deps.services.sessions.createSession({
			project_id: projectId,
			notebook_id: notebookId,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
		});
		sessionId = session.session_id;
		await setup.deps.services.sessions.setRunning(projectId, sessionId, 'https://sandbox.example');

		const error = await expectError(
			await setup.request('POST', route(), {}, { 'Idempotency-Key': 'missing-source-revision' }),
			409,
			'CONFLICT',
		);
		expect(error.message).toContain('no synced source revision');
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it('rejects unchanged notebook content without calling the provider', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'print("before")' } });
		const unchanged = createTestApi({
			bucket: setup.bucket,
			compute: fakeComputeFrom(instance),
			deps: { sourceControl: setup.deps.sourceControl },
		});
		await expectError(
			await unchanged.request('POST', route(), {}, { 'Idempotency-Key': 'unchanged-notebook' }),
			409,
			'CONFLICT',
		);
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it('uses distinct deterministic proposal branches for distinct idempotency keys', async () => {
		await expectOk(
			await setup.request('POST', route(), {}, { 'Idempotency-Key': 'first-change' }),
			201,
		);
		await expectOk(
			await setup.request('POST', route(), {}, { 'Idempotency-Key': 'second-change' }),
			201,
		);
		expect(openChangeRequest).toHaveBeenCalledTimes(2);
		expect(openChangeRequest.mock.calls[0]?.[0].headBranch).not.toBe(
			openChangeRequest.mock.calls[1]?.[0].headBranch,
		);
	});

	it('replays the first response when a retry changes text or update target', async () => {
		const headers = { 'Idempotency-Key': 'same-operation' };
		const first = await expectOk<{ change_request: { number: number } }>(
			await setup.request('POST', route(), { title: 'First title' }, headers),
			201,
		);
		const second = await expectOk<{ change_request: { number: number } }>(
			await setup.request(
				'POST',
				route(),
				{ title: 'Different title', target_proposal_id: createProposalId() },
				headers,
			),
			201,
		);
		expect(second).toEqual(first);
		expect(openChangeRequest).toHaveBeenCalledOnce();
		expect(openChangeRequest.mock.calls[0]?.[0].title).toBe('First title');
	});

	it('returns a service error and keeps the proposal retryable for malformed provider output', async () => {
		openChangeRequest.mockImplementationOnce(async (providerInput) => ({
			number: 0,
			url: 'http://github.com/owner/repo/pull/0',
			headBranch: providerInput.headBranch,
			headCommit: '',
		}));
		const headers = { 'Idempotency-Key': 'malformed-provider' };
		await expectError(
			await setup.request('POST', route(), {}, headers),
			503,
			'SERVICE_UNAVAILABLE',
		);
		await expectOk(await setup.request('POST', route(), {}, headers), 201);
		expect(openChangeRequest).toHaveBeenCalledTimes(2);
	});
});
