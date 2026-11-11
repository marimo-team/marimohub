import { createRoute, z } from '@hono/zod-openapi';
import { idempotentCreate } from '../idempotency';
import {
	commonErrors,
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
	NotebookIdParam,
	RequiredIdempotencyKeyHeader,
	SessionIdParam,
} from '../shared';
import {
	auditWorkingBranch,
	authorizeWorkingNotebook,
	OpenWorkingBranchPrBody,
	readWorkingBranchSave,
	SaveWorkingBranchBody,
	saveWorkingBranch,
	resumeWorkingBranch,
	WorkingBranchSaveResponse,
	WorkingBranchStatusResponse,
	WorkingBranchChangeRequestResponse,
	toWorkingBranchChangeRequest,
	toWorkingBranchStatus,
} from '../workingBranches';

const tags = ['Working branches'];
const errors = { ...commonErrors(), ...errorResponses(400, 403, 404, 409, 503) };
const saveResponses = {
	200: jsonContent(
		z.object({ success: z.literal(true), data: WorkingBranchSaveResponse }),
		'Save operation',
	),
	...errors,
};
const SaveParam = NotebookIdParam.extend({ save_id: z.string().regex(/^[a-f0-9]{64}$/) });
const save = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}/working-branch/saves',
	operationId: 'notebooks.working-branch.saves.create',
	tags,
	summary: 'Commit source changes to the working branch',
	description:
		'Requires working-branch.write and access to the session. Reuse Idempotency-Key to resume the same captured changes. The returned state distinguishes confirmed commits from pending synchronization and conflicts. Does not save excluded runtime files.',
	request: {
		params: SessionIdParam,
		headers: RequiredIdempotencyKeyHeader,
		body: jsonBody(SaveWorkingBranchBody),
	},
	responses: saveResponses,
});
const status = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/working-branch',
	operationId: 'notebooks.working-branch.get',
	tags,
	summary: 'Inspect the working branch and latest save',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: WorkingBranchStatusResponse }),
			'Working branch status',
		),
		...errors,
	},
});
const getSave = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/working-branch/saves/{save_id}',
	operationId: 'notebooks.working-branch.saves.get',
	tags,
	summary: 'Inspect a captured save operation',
	description: 'Only the save author or a project manager can read the receipt.',
	request: { params: SaveParam },
	responses: saveResponses,
});
const retry = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/working-branch/saves/{save_id}/retry',
	operationId: 'notebooks.working-branch.saves.retry',
	tags,
	summary: 'Resume an existing save operation',
	description:
		'The save author can resume any stage. Any editor can resume a save whose commit is already on GitHub (`remote_committed` or `hub_synced`). Reuses its immutable capture and commit; does not require the original Idempotency-Key.',
	request: { params: SaveParam },
	responses: saveResponses,
});
const recovery = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/working-branch/saves/{save_id}/recovery',
	operationId: 'notebooks.working-branch.saves.recovery',
	tags,
	summary: 'Download captured source changes for recovery',
	description:
		'Returns a ZIP containing a manifest of modifications/deletions and captured file bytes. Only the save author or a project manager can download it. Payloads become eligible for cleanup at expires_at. Captures of unfinished dispatched saves (`ref_dispatched`, `remote_committed`, `hub_synced`) stay until the save finishes. Downloads remain available until the payload is pruned.',
	request: { params: SaveParam },
	responses: {
		200: {
			description: 'Recovery archive',
			content: { 'application/zip': { schema: z.string().openapi({ format: 'binary' }) } },
		},
		...errors,
	},
});
const openPr = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/working-branch/change-request',
	operationId: 'notebooks.working-branch.change-request.open',
	tags,
	summary: 'Open the working branch pull request',
	description:
		'Opens or returns the one pull request associated with this working branch. Does not capture or commit unsaved session edits. The Idempotency-Key header is required; retry with the same key after a lost response.',
	request: {
		params: NotebookIdParam,
		headers: RequiredIdempotencyKeyHeader,
		body: jsonBody(OpenWorkingBranchPrBody),
	},
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: WorkingBranchChangeRequestResponse }),
			'Working branch pull request',
		),
		...errors,
	},
});

const app = createApp();
app.openapi(save, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');
	const receipt = await saveWorkingBranch(deps, user, {
		projectId: pid,
		notebookId: nid,
		sessionId: sid,
		idempotencyKey: c.req.valid('header')['idempotency-key'],
		...c.req.valid('json'),
	});
	await auditWorkingBranch(
		deps,
		user,
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path },
		'notebook.working_branch.save',
		pid,
		nid,
		{ save_id: receipt.id, state: receipt.state, commit: receipt.commit },
	);
	return c.json({ success: true, data: WorkingBranchSaveResponse.parse(receipt) }, 200);
});
app.openapi(status, async (c) => {
	const deps = c.get('deps');
	const { pid, nid } = c.req.valid('param');
	await authorizeWorkingNotebook(deps, c.get('user'), pid, nid);
	return c.json(
		{
			success: true,
			data: toWorkingBranchStatus(await deps.services.workingBranches.status(pid, nid)),
		},
		200,
	);
});
app.openapi(getSave, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, save_id } = c.req.valid('param');
	const receipt = await readWorkingBranchSave(deps, c.get('user'), pid, nid, save_id);
	return c.json({ success: true, data: WorkingBranchSaveResponse.parse(receipt) }, 200);
});
app.openapi(recovery, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, save_id } = c.req.valid('param');
	await readWorkingBranchSave(deps, c.get('user'), pid, nid, save_id);
	const bytes = await deps.services.workingBranches.recovery(pid, nid, save_id);
	return c.body(Uint8Array.from(bytes), 200, {
		'Content-Type': 'application/zip',
		'Content-Disposition': `attachment; filename="save-${save_id}.zip"`,
		'Cache-Control': 'private, no-store',
	});
});
app.openapi(retry, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, save_id } = c.req.valid('param');
	const receipt = await resumeWorkingBranch(deps, user, pid, nid, save_id);
	await auditWorkingBranch(
		deps,
		user,
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path },
		'notebook.working_branch.retry',
		pid,
		nid,
		{ save_id, state: receipt.state, commit: receipt.commit },
	);
	return c.json({ success: true, data: WorkingBranchSaveResponse.parse(receipt) }, 200);
});
app.openapi(openPr, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await authorizeWorkingNotebook(deps, user, pid, nid);
	const data = await idempotentCreate(
		c,
		'POST /projects/{pid}/notebooks/{nid}/working-branch/change-request',
		async () => {
			const opened = await deps.services.workingBranches.openChangeRequest(
				pid,
				nid,
				user.id,
				c.req.valid('json'),
				async () => {
					await authorizeWorkingNotebook(deps, user, pid, nid);
				},
			);
			await auditWorkingBranch(
				deps,
				user,
				{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path },
				'notebook.working_branch.open_pr',
				pid,
				nid,
				{ change_request: opened.number },
			);
			return toWorkingBranchChangeRequest(opened);
		},
	);
	return c.json({ success: true, data }, 201);
});
export default app;
