import { createRoute, z } from '@hono/zod-openapi';
import {
	ConflictError,
	deriveProposalId,
	NotFoundError,
	ProposalId,
	UnavailableError,
} from '@marimo-hub/core';
import type {
	GitSourceRevision,
	NotebookProposal,
	NotebookProposalRecord,
	SourceControlPublisher,
} from '@marimo-hub/core';
import { idempotentCreate } from '../idempotency';
import { appendAudit } from '../log';
import {
	assertProjectRole,
	commonErrors,
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
	RequiredIdempotencyKeyHeader,
	SessionIdParam,
} from '../shared';

const OpenChangeRequestBody = z
	.object({
		title: z.string().trim().min(1).max(256).optional().openapi({
			description: 'Change request title. Defaults to the notebook title.',
			example: 'Update revenue dashboard',
		}),
		body: z.string().max(65_536).optional().openapi({
			description: 'Change request description. Defaults to the session and base commit.',
			example: 'Updates the regional revenue analysis.',
		}),
	})
	.openapi('OpenNotebookChangeRequestBody');

const ChangeRequestResponse = z
	.object({
		proposal_id: z.string().regex(ProposalId.regex).refine(ProposalId.is).openapi({
			description:
				'Identifier of the immutable proposal captured from the notebook session and published by this change request.',
			example: 'prop-7h2k9qm4xz7rp3w8',
		}),
		change_request: z.object({
			provider: z.string().min(1).openapi({ example: 'github' }),
			number: z.number().int().positive().openapi({ example: 42 }),
			url: z
				.url()
				.refine((value) => value.startsWith('https://'), 'Change request URL must use HTTPS')
				.openapi({ example: 'https://github.com/acme/analytics/pull/42' }),
			head_branch: z.string().min(1).openapi({
				example: 'marimohub/nb-7h2k9qm4xz7rp3w8/prop-7h2k9qm4xz7rp3w8',
			}),
			head_commit: z.string().min(1).openapi({ example: '9e107d9d372bb6826bd81d3542a419d6' }),
		}),
	})
	.openapi('OpenNotebookChangeRequestResult');

const openChangeRequest = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}/change-requests',
	operationId: 'openNotebookChangeRequest',
	tags: ['Source control publishing'],
	summary: 'Open a draft change request from a live notebook session',
	description:
		'A proposal is an immutable set of notebook changes captured with its exact source revision. This operation captures a proposal from a running persistent editor session and publishes it as a pull request, merge request, or equivalent through the configured source-control provider. The Idempotency-Key header is required; retry with the same key to resume the same proposal and provider branch. If the error code is PROPOSAL_RETRY_REQUIRED, retry with a new key instead.',
	request: {
		params: SessionIdParam,
		headers: RequiredIdempotencyKeyHeader,
		body: jsonBody(OpenChangeRequestBody),
	},
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: ChangeRequestResponse }),
			'Draft change request opened',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409, 503),
	},
});

const changeRequestRoutes = createApp();

changeRequestRoutes.openapi(openChangeRequest, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');
	const idempotencyKey = c.req.valid('header')['idempotency-key'];
	const request = c.req.valid('json');
	await assertProjectRole(deps.services.projects, pid, user, 'manager', deps.policy);
	const routeId = `POST /projects/${pid}/notebooks/${nid}/sessions/${sid}/change-requests`;
	const data = await idempotentCreate(c, routeId, async () => {
		const proposalId = await deriveProposalId(`${user.id}\n${routeId}\n${idempotencyKey}`);
		const notebook = await deps.services.notebooks.getNotebook(pid, nid);
		let reusableProposal: NotebookProposalRecord | undefined;
		try {
			reusableProposal = await deps.services.proposals.getReusableProposal(pid, nid, proposalId);
		} catch (error) {
			if (!(error instanceof NotFoundError)) throw error;
		}
		const requirePublisher = (provider: string): SourceControlPublisher => {
			const publisher = deps.sourceControlPublishers?.getPublisher(provider);
			if (!publisher) {
				throw new UnavailableError(`Change-request publishing is not configured for ${provider}`);
			}
			return publisher;
		};
		let publisher: SourceControlPublisher | undefined;
		let proposal: NotebookProposal;
		if (reusableProposal) {
			proposal = reusableProposal.proposal;
			if (
				proposal.proposal_id !== proposalId ||
				proposal.notebook_id !== nid ||
				proposal.session_id !== sid ||
				proposal.author !== user.id
			) {
				throw new ConflictError('The idempotency key belongs to a different proposal');
			}
			if (reusableProposal.publication.state === 'pending') {
				publisher = requirePublisher(proposal.source.provider);
			}
		} else {
			const session = await deps.services.sessions.getSession(pid, sid);
			if (notebook.source.type !== 'git') {
				throw new ConflictError('Only git-synced notebooks can open change requests');
			}
			if (!session.sandbox_id) throw new ConflictError('The session has no sandbox');
			if (!session.source_version_id) {
				throw new ConflictError('The session has no synced source revision');
			}

			const legacySourceRevision: GitSourceRevision | undefined =
				session.source_version_id === notebook.source.current_version_id &&
				notebook.source.commit &&
				notebook.source.provider
					? {
							provider: notebook.source.provider,
							repo: notebook.source.repo,
							branch: notebook.source.branch,
							root_path: notebook.source.root_path,
							entry_notebook: notebook.source.entry_notebook,
							commit: notebook.source.commit,
						}
					: undefined;
			const sourceRevision = await deps.services.proposals.resolveSourceRevision(
				pid,
				nid,
				session.source_version_id,
				legacySourceRevision,
			);
			publisher = requirePublisher(sourceRevision.provider);
			proposal = await deps.services.proposals.captureEntryNotebook({
				projectId: pid,
				notebookId: nid,
				proposalId,
				session,
				sandbox: deps.compute.create(session.sandbox_id),
				workdir: deps.sandbox.workdir,
				author: user.id,
				resolvedSourceRevision: sourceRevision,
			});
		}
		const changeRequest = await deps.services.proposals.publishChangeRequest({
			projectId: pid,
			notebookId: nid,
			proposalId: proposal.proposal_id,
			publisher,
			title: request.title ?? `Update ${notebook.meta.title}`,
			body:
				request.body ??
				`Changes proposed from marimohub session ${sid}.\n\nBase commit: ${proposal.source.commit}`,
		});
		await appendAudit(
			{
				requestId: c.get('requestId'),
				method: c.req.method,
				path: c.req.path,
				userId: user.id,
			},
			'notebook.change_request.open',
			() =>
				deps.services.events.append({
					event: 'notebook.change_request.open',
					actor: user.id,
					project_id: pid,
					notebook_id: nid,
					session_id: sid,
					proposal_id: proposal.proposal_id,
					provider: proposal.source.provider,
					change_request_number: changeRequest.number,
				}),
		);
		return {
			proposal_id: proposal.proposal_id,
			change_request: {
				provider: proposal.source.provider,
				number: changeRequest.number,
				url: changeRequest.url,
				head_branch: changeRequest.headBranch,
				head_commit: changeRequest.headCommit,
			},
		};
	});
	return c.json({ success: true, data }, 201);
});

export default changeRequestRoutes;
