import { createRoute, z } from '@hono/zod-openapi';
import { deriveProposalId, ProposalId, sourceControlPublishFailure } from '@marimo-hub/core';
import type {
	AuthUser,
	OpenChangeRequestResult,
	SourceControlCommitIdentity,
} from '@marimo-hub/core';
import { idempotentCreate } from '../idempotency';
import { appendAudit, logEvent } from '../log';
import { prepareProposal } from './changeRequestPublishing';
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
		target_proposal_id: z
			.string()
			.regex(ProposalId.regex)
			.refine(ProposalId.is)
			.optional()
			.openapi({
				description:
					'Published proposal whose existing change request should receive this new proposal. Omit to create a new change request.',
				example: 'prop-7h2k9qm4xz7rp3w8',
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

function commitCoAuthor(user: AuthUser): SourceControlCommitIdentity {
	const at = user.email.indexOf('@');
	const emailName = at > 0 ? user.email.slice(0, at) : user.email;
	return { name: user.name?.trim() || emailName, email: user.email };
}

const openChangeRequest = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}/change-requests',
	operationId: 'notebooks.change-requests.open',
	tags: ['Source control publishing'],
	summary: 'Publish notebook changes to a new or existing change request',
	description:
		'A proposal is an immutable set of notebook changes captured with its exact source revision. This operation captures a proposal from a running persistent editor session and publishes it as a pull request, merge request, or equivalent through the configured source-control provider. Set target_proposal_id to update the change request published by that proposal; omit it to create a new change request. The Idempotency-Key header is required; retry with the same key to resume the same operation. If the error code is PROPOSAL_RETRY_REQUIRED, retry with a new key instead.',
	request: {
		params: SessionIdParam,
		headers: RequiredIdempotencyKeyHeader,
		body: jsonBody(OpenChangeRequestBody),
	},
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: ChangeRequestResponse }),
			'Change request published',
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
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'change-request.publish',
		deps.policy,
	);
	const routeId = `POST /projects/${pid}/notebooks/${nid}/sessions/${sid}/change-requests`;
	const data = await idempotentCreate(c, routeId, async () => {
		const proposalId = await deriveProposalId(`${user.id}\n${routeId}\n${idempotencyKey}`);
		const { proposal, publisher, notebookTitle, state } = await prepareProposal({
			deps,
			project,
			notebookId: nid,
			sessionId: sid,
			proposalId,
			author: user.id,
			subject: user,
			targetProposalId: request.target_proposal_id,
		});
		const eventContext = {
			request_id: c.get('requestId') ?? null,
			user_id: user.id,
			project_id: pid,
			notebook_id: nid,
			proposal_id: proposal.proposal_id,
		};
		if (state === 'new') {
			logEvent({
				level: 'info',
				event: 'change_request.captured',
				...eventContext,
				size_bytes: proposal.changes.reduce(
					(total, change) => total + (change.operation === 'delete' ? 0 : change.size_bytes),
					0,
				),
			});
		}
		const publishStartedAt = Date.now();
		let changeRequest: OpenChangeRequestResult;
		try {
			changeRequest = await deps.services.proposals.publishChangeRequest({
				projectId: pid,
				notebookId: nid,
				proposalId: proposal.proposal_id,
				publisher,
				title: request.title ?? `Update ${notebookTitle ?? 'notebook'}`,
				body:
					request.body ??
					`Changes proposed from marimohub session ${sid}.\n\nBase commit: ${proposal.source.commit}`,
				coAuthor: commitCoAuthor(user),
			});
		} catch (error) {
			const failure = sourceControlPublishFailure(error);
			if (failure) {
				logEvent({
					level: 'warn',
					event: 'change_request.publish_failed',
					...eventContext,
					provider: failure.provider,
					repo: proposal.source.repo,
					stage: failure.stage,
					condition: failure.condition ?? null,
					status: failure.status ?? null,
					latency_ms: Date.now() - publishStartedAt,
				});
			}
			throw error;
		}
		if (state === 'published') {
			logEvent({
				level: 'info',
				event: 'change_request.reused',
				...eventContext,
				provider: proposal.source.provider,
				repo: proposal.source.repo,
				pr_number: changeRequest.number,
			});
		} else {
			logEvent({
				level: 'info',
				event: 'change_request.published',
				...eventContext,
				provider: proposal.source.provider,
				repo: proposal.source.repo,
				pr_number: changeRequest.number,
				latency_ms: Date.now() - publishStartedAt,
			});
		}
		const auditEvent = proposal.target_proposal_id
			? 'notebook.change_request.update'
			: 'notebook.change_request.open';
		await appendAudit(
			{
				requestId: c.get('requestId'),
				method: c.req.method,
				path: c.req.path,
				userId: user.id,
			},
			auditEvent,
			() =>
				deps.services.events.append({
					event: auditEvent,
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
