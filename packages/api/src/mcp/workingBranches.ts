import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SessionId, toPublicNotebookMeta, toPublicSource } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, WorkingBranchSave } from '@marimo-hub/core';
import type { ResolvedApiDeps } from '../context';
import type { StartRequestContext } from './server';
import { result, toolError } from './results';
import {
	PROJECT_REFERENCE_DESCRIPTION,
	NOTEBOOK_REFERENCE_DESCRIPTION,
	resolveProject,
	resolveAuthorizedNotebook,
} from './selectors';
import { authorizeSessionStart } from '../routes/sessionStart';
import { startMcpSession } from './sessionStartup';
import { checkComputeProfile } from '../computeProfile';
import {
	auditWorkingBranch,
	authorizeWorkingNotebook,
	authorizeWorkingBranchCreation,
	saveWorkingBranch,
	resumeWorkingBranch,
	OpenWorkingBranchPrBody,
	readWorkingBranchSave,
	SaveWorkingBranchBody,
	WorkingBranchSaveResponse,
	toWorkingBranchStatus,
	toWorkingBranchChangeRequest,
} from '../workingBranches';

const project = z.string().trim().min(1).describe(PROJECT_REFERENCE_DESCRIPTION);
const notebook = z.string().trim().min(1).describe(NOTEBOOK_REFERENCE_DESCRIPTION);
const selection = z.object({ project, notebook });
const key = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.describe(
		'Stable key for this operation. Reuse after a timeout; use a new key only for new work.',
	);
const saveId = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.describe('Save operation id returned by save_to_branch or get_working_branch.');
const mutations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

export function registerWorkingBranchTools(
	server: McpServer,
	deps: ResolvedApiDeps,
	principal: AuthenticatedPrincipal,
	request: StartRequestContext,
) {
	const resolveNotebook = (input: z.infer<typeof selection>) =>
		resolveAuthorizedNotebook(
			deps,
			principal,
			input.project,
			input.notebook,
			'working-branch.write',
		);
	const saveResult = (receipt: WorkingBranchSave) => ({
		...WorkingBranchSaveResponse.parse(receipt),
		recovery_url: `${request.appBaseUrl}/api/v1/projects/${receipt.project_id}/notebooks/${receipt.notebook_id}/working-branch/saves/${receipt.id}/recovery`,
	});

	function register<T extends { project: string }>(
		name: string,
		description: string,
		schema: z.ZodType<T>,
		readOnly: boolean,
		run: (input: T, signal: AbortSignal) => Promise<Record<string, unknown>>,
	) {
		server.registerTool(
			name,
			{ description, inputSchema: schema, annotations: { ...mutations, readOnlyHint: readOnly } },
			async (input, extra) => {
				const signal = request.signal
					? AbortSignal.any([request.signal, extra.signal])
					: extra.signal;
				try {
					signal.throwIfAborted();
					return result(await run(input, signal));
				} catch (error) {
					return toolError(error, { ...request, signal, userId: principal.id, tool: name });
				}
			},
		);
	}
	register(
		'create_branch_notebook',
		'Create a new working branch from a base branch and import an existing entry notebook. Provider credentials stay on the server. Requires working-branch.write; optional launch starts an edit session.',
		z.object({
			project,
			title: z.string().min(1),
			description: z.string().default(''),
			repo: z.string().min(1),
			base_branch: z.string().min(1),
			root_path: z.string().default(''),
			entry_notebook: z.string().min(1),
			idempotency_key: key,
			compute_profile: z.string().min(1).optional(),
			launch: z.boolean().default(false),
		}),
		false,
		async ({ project: projectRef, idempotency_key, launch, ...input }, signal) => {
			const p = await resolveProject(deps, principal, projectRef, 'working-branch.write');
			if (launch) await authorizeSessionStart(p, principal, 'edit', deps);
			signal.throwIfAborted();
			const detail = await deps.services.workingBranches.create(
				p.id,
				principal.id,
				idempotency_key,
				{
					...input,
					compute_profile: checkComputeProfile(deps.sandbox, input.compute_profile) ?? undefined,
					sync_mode: 'pull',
				},
				async (notebook) => {
					signal.throwIfAborted();
					await authorizeWorkingBranchCreation(deps, principal, p.id, notebook);
				},
			);
			await auditWorkingBranch(
				deps,
				principal,
				request,
				'notebook.working_branch.create',
				p.id,
				detail.meta.id,
			);
			const data = {
				project_id: p.id,
				notebook_id: detail.meta.id,
				notebook: toPublicNotebookMeta(detail.meta),
				source: toPublicSource(detail.source),
				notebook_url: `${request.appBaseUrl}/projects/${p.id}/notebooks/${detail.meta.id}`,
			};
			if (!launch) return { ...data, launched: false };
			const session = await startMcpSession({
				deps,
				principal,
				request: { ...request, signal },
				project: p,
				notebookId: detail.meta.id,
				mode: 'edit',
				waitSeconds: 60,
			});
			return { ...data, launched: true, session };
		},
	);
	register(
		'save_to_branch',
		'Commit eligible source files under the notebook root from a running editor. Reuse the key to resume a captured save. Inspect state: remote commits may still need hub synchronization. Excluded runtime files are not saved.',
		selection.extend({
			session_id: z.string().regex(SessionId.regex).refine(SessionId.is),
			idempotency_key: key,
			...SaveWorkingBranchBody.shape,
		}),
		false,
		async (input, signal) => {
			const { project: p, notebook: n } = await resolveNotebook(input);
			signal.throwIfAborted();
			const receipt = await saveWorkingBranch(deps, principal, {
				projectId: p.id,
				notebookId: n.id,
				sessionId: SessionId.parse(input.session_id),
				idempotencyKey: input.idempotency_key,
				message: input.message,
			});
			await auditWorkingBranch(
				deps,
				principal,
				request,
				'notebook.working_branch.save',
				p.id,
				n.id,
				{ save_id: receipt.id, state: receipt.state, commit: receipt.commit },
			);
			return saveResult(receipt);
		},
	);
	register(
		'open_change_request',
		'Open or return the working branch PR into its recorded base. Does not commit unsaved edits. Later saves update its head branch. Draft by default.',
		selection.extend(OpenWorkingBranchPrBody.shape),
		false,
		async (input, signal) => {
			const { project: p, notebook: n } = await resolveNotebook(input);
			signal.throwIfAborted();
			const change_request = await deps.services.workingBranches.openChangeRequest(
				p.id,
				n.id,
				principal.id,
				input,
				async () => {
					signal.throwIfAborted();
					await authorizeWorkingNotebook(deps, principal, p.id, n.id);
				},
			);
			await auditWorkingBranch(
				deps,
				principal,
				request,
				'notebook.working_branch.open_pr',
				p.id,
				n.id,
				{ change_request: change_request.number },
			);
			return {
				project_id: p.id,
				notebook_id: n.id,
				change_request: toWorkingBranchChangeRequest(change_request),
			};
		},
	);
	register(
		'get_working_branch',
		'Inspect the remote branch, PR lifecycle, and latest save stage. Requires current notebook authorization.',
		selection,
		true,
		async (input) => {
			const { project: p, notebook: n } = await resolveNotebook(input);
			return {
				project_id: p.id,
				notebook_id: n.id,
				...toWorkingBranchStatus(await deps.services.workingBranches.status(p.id, n.id)),
			};
		},
	);
	register(
		'get_branch_save',
		'Inspect your save receipt and obtain an authenticated recovery archive URL. Only the save author or a project manager can read it. Captured bytes become eligible for cleanup at expires_at unless retained for unresolved publication.',
		selection.extend({ save_id: saveId }),
		true,
		async (input) => {
			const { project: p, notebook: n } = await resolveNotebook(input);
			return saveResult(await readWorkingBranchSave(deps, principal, p.id, n.id, input.save_id));
		},
	);
	register(
		'retry_branch_save',
		'Resume an existing save by operation id without recapturing changes. Use after reloading or a partial provider/hub failure. Authors can resume any stage; any editor can finish a save already committed on GitHub.',
		selection.extend({ save_id: saveId }),
		false,
		async (input, signal) => {
			const { project: p, notebook: n } = await resolveNotebook(input);
			signal.throwIfAborted();
			const receipt = await resumeWorkingBranch(deps, principal, p.id, n.id, input.save_id);
			await auditWorkingBranch(
				deps,
				principal,
				request,
				'notebook.working_branch.retry',
				p.id,
				n.id,
				{ save_id: receipt.id, state: receipt.state },
			);
			return saveResult(receipt);
		},
	);
}

export function workingBranchConsentInput(
	deps: ResolvedApiDeps,
	principal: AuthenticatedPrincipal,
	projectId: string,
	name: string,
) {
	if (!['save_to_branch', 'open_change_request', 'retry_branch_save'].includes(name)) return;
	return async (rawInput: Record<string, unknown>) => {
		const input =
			name === 'open_change_request' ? { ...rawInput, draft: rawInput.draft ?? true } : rawInput;
		if (typeof input.notebook !== 'string') return input;
		const { project, notebook } = await resolveAuthorizedNotebook(
			deps,
			principal,
			projectId,
			input.notebook,
			'working-branch.write',
		);
		const source = await deps.services.notebooks.getNotebookSource(project.id, notebook.id);
		return source.type === 'git'
			? {
					...input,
					notebook: notebook.title,
					repo: source.repo,
					branch: source.branch,
					base_branch: source.working_branch?.base_branch,
				}
			: input;
	};
}
