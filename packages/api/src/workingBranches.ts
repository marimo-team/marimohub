import {
	ConflictError,
	ForbiddenError,
	NotFoundError,
	sessionOwner,
	WorkingBranchSaveSchema,
	WorkingBranchChangeRequestSchema,
} from '@marimo-hub/core';
import type {
	AuthenticatedPrincipal,
	NotebookId,
	NotebookMeta,
	ProjectId,
	Session,
	SessionId,
	WorkingBranchRecord,
	WorkingBranchService,
} from '@marimo-hub/core';
import { z } from '@hono/zod-openapi';
import type { ApiDeps } from './context';
import {
	assertProjectRole,
	assertSessionAccess,
	authorizationService,
	authorizeNotebookMeta,
	extensibleResponseEnum,
	loadAuthorizedNotebook,
} from './shared';
import { appendAudit } from './log';

export const SaveWorkingBranchBody = z.object({
	message: z.string().trim().min(1).max(65_536).optional(),
});
export const OpenWorkingBranchPrBody = z.object({
	title: z.string().trim().min(1).max(256).optional(),
	body: z.string().max(65_536).optional(),
	draft: z.boolean().default(true),
});
export const WorkingBranchSaveResponse = WorkingBranchSaveSchema.omit({
	schema_version: true,
	fingerprint: true,
	co_author: true,
	publication_actor: true,
	signed_preparation: true,
}).openapi('WorkingBranchSave');
const CHANGE_REQUEST_STATES = ['open', 'closed', 'merged'] as const satisfies readonly z.infer<
	typeof WorkingBranchChangeRequestSchema
>['state'][];
const ENDED_REASONS = [
	'branch_deleted',
	'pr_closed',
	'pr_merged',
	'pr_retargeted',
] as const satisfies readonly NonNullable<WorkingBranchRecord['ended_reason']>[];
export const WorkingBranchChangeRequestResponse = WorkingBranchChangeRequestSchema.extend({
	state: extensibleResponseEnum(CHANGE_REQUEST_STATES, 'open'),
}).openapi('WorkingBranchChangeRequestResponse');
export const WorkingBranchStatusResponse = z
	.object({
		base_branch: z.string(),
		branch: z.string(),
		commit: z.string().nullable(),
		remote_commit: z.string().nullable(),
		change_request: WorkingBranchChangeRequestResponse.optional(),
		checked_at: z.string().optional(),
		last_save: WorkingBranchSaveResponse.optional(),
		active_save: z.string().optional(),
		ended_reason: extensibleResponseEnum(ENDED_REASONS, 'pr_merged').optional(),
	})
	.openapi('WorkingBranchStatus');

export function toWorkingBranchChangeRequest(
	request: z.infer<typeof WorkingBranchChangeRequestSchema>,
) {
	return WorkingBranchChangeRequestResponse.parse(request);
}

export function toWorkingBranchStatus(status: Awaited<ReturnType<WorkingBranchService['status']>>) {
	return WorkingBranchStatusResponse.parse({
		...status,
		change_request: status.change_request && toWorkingBranchChangeRequest(status.change_request),
	});
}

export async function authorizeWorkingBranchCreation(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	pid: ProjectId,
	notebook?: NotebookMeta,
) {
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		principal,
		'working-branch.write',
		deps,
	);
	if (notebook)
		await authorizeNotebookMeta(deps, project, notebook, principal, 'working-branch.write');
}

export async function authorizeWorkingNotebook(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	pid: ProjectId,
	nid: NotebookId,
) {
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		principal,
		'working-branch.write',
		deps,
	);
	const detail = await loadAuthorizedNotebook(
		deps,
		project,
		nid,
		principal,
		'working-branch.write',
	);
	return { project, detail };
}

type AuthorizedWorkingNotebook = Awaited<ReturnType<typeof authorizeWorkingNotebook>>;

async function loadAuthorizedSave(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	pid: ProjectId,
	nid: NotebookId,
	id: string,
) {
	const authorized = await authorizeWorkingNotebook(deps, principal, pid, nid);
	const receipt = await deps.services.workingBranches.getSave(pid, nid, id);
	return { authorized, receipt };
}

/** Captures can hold unpublished, untracked files from the author's private sandbox. */
export async function readWorkingBranchSave(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	pid: ProjectId,
	nid: NotebookId,
	id: string,
) {
	const {
		authorized: { project, detail },
		receipt,
	} = await loadAuthorizedSave(deps, principal, pid, nid, id);
	if (receipt.author === principal.id) return receipt;
	const manager = await authorizationService(deps).authorize(principal, 'notebook.manage', {
		kind: 'project',
		project,
		notebookLabels: detail.meta.security_labels ?? null,
	});
	if (!manager.allowed) {
		throw new ForbiddenError('Only the save author or a project manager can read this save');
	}
	return receipt;
}

async function saveOptions(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	input: {
		projectId: ProjectId;
		notebookId: NotebookId;
		sessionId: SessionId;
	},
	initial?: AuthorizedWorkingNotebook,
) {
	const authorize = async (authorized?: AuthorizedWorkingNotebook) => {
		const { project, detail } =
			authorized ??
			(await authorizeWorkingNotebook(deps, principal, input.projectId, input.notebookId));
		let session;
		try {
			session = await deps.services.sessions.getSession(project.id, input.sessionId);
		} catch (error) {
			// A captured receipt can finish after its session record is gone; fresh capture still requires it.
			if (error instanceof NotFoundError) return;
			throw error;
		}
		if (session.notebook_id !== input.notebookId) throw new NotFoundError('Session not found');
		await assertSessionAccess(
			project,
			session,
			principal,
			deps,
			detail.meta.security_labels ?? null,
		);
	};
	await authorize(initial);
	return {
		workdir: deps.sandbox.workdir,
		getSandbox: (session: Session) => {
			if (!session.sandbox_id) throw new NotFoundError('Session sandbox not found');
			return deps.compute.create(session.sandbox_id, { owner: sessionOwner(session) });
		},
		authorize: () => authorize(),
	};
}

export async function saveWorkingBranch(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	input: {
		projectId: ProjectId;
		notebookId: NotebookId;
		sessionId: SessionId;
		idempotencyKey: string;
		message?: string;
	},
) {
	const options = await saveOptions(deps, principal, input);
	return deps.services.workingBranches.save({
		...options,
		...input,
		actor: principal.id,
		coAuthor: {
			name: principal.name?.trim() || principal.email.split('@')[0],
			email: principal.email,
		},
	});
}

export async function resumeWorkingBranch(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	pid: ProjectId,
	nid: NotebookId,
	id: string,
) {
	const { authorized, receipt } = await loadAuthorizedSave(deps, principal, pid, nid, id);
	const service = deps.services.workingBranches;
	if (!service.canResume(receipt, principal.id))
		throw new ConflictError('Only the save author can retry this operation');
	if (receipt.author !== principal.id) {
		// Non-authors can finish only stages that import an already-public commit,
		// so they never need the author's session or sandbox.
		return service.resume(pid, nid, id, principal.id, {
			workdir: deps.sandbox.workdir,
			getSandbox: () => {
				throw new ForbiddenError('Only the save author can capture session changes');
			},
			authorize: async () => {
				await authorizeWorkingNotebook(deps, principal, pid, nid);
			},
		});
	}
	const options = await saveOptions(
		deps,
		principal,
		{
			projectId: pid,
			notebookId: nid,
			sessionId: receipt.session_id,
		},
		authorized,
	);
	return service.resume(pid, nid, id, principal.id, options);
}

export async function auditWorkingBranch(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	request: { requestId?: string; method: string; path: string },
	event: string,
	pid: ProjectId,
	nid: NotebookId,
	fields: Record<string, unknown> = {},
) {
	await appendAudit(deps, { ...request, userId: principal.id }, event, () =>
		deps.services.events.append({
			event,
			actor: principal.id,
			project_id: pid,
			notebook_id: nid,
			...fields,
		}),
	);
}
