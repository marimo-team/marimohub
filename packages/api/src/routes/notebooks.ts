import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { zipSync } from 'fflate';
import {
	applyGitSourceUpdate,
	assertSyncedSource,
	BadRequestError,
	createGitSource,
	DomainError,
	ForbiddenError,
	NotebookId,
	NotFoundError,
	notificationRouter,
	ProjectId,
	sourceDrift,
	toPublicNotebookMeta,
	toPublicSource,
	toPublicVersion,
	VersionId,
} from '@marimo-hub/core';
import {
	assertProjectRole,
	assertProjectVisible,
	commonErrors,
	createApp,
	errorResponses,
	etagFor,
	EtagResponseHeader,
	fail,
	ifMatchToken,
	IfMatchHeader,
	IdempotencyKeyHeader,
	jsonBody,
	jsonContent,
	GitSourceResponseSchema,
	NotebookDetailResponseSchema,
	NotebookIdParam,
	NotebookMetaResponseSchema,
	ProjectIdParam,
	RuntimeResponseSchema,
	NotebookVersionResponseSchema,
	retireLiveApps,
	SnapshotNotebookEntrySchema,
	SuccessResponseSchema,
} from '../shared';
import { idempotentCreate } from '../idempotency';
import { appendAudit } from '../log';
import { assertPullSourceSupported, pullSourceToHead, resolveSyncTarget } from './sourcePullSync';
import type { HonoEnv, SandboxConfig } from '../context';
import { pageSchema, paginate, PaginationQuery } from '../pagination';
import { scheduleProjectAlert } from '../notifications';

// --- Request body schemas ---

const CreateNotebookBody = z.object({
	title: z.string().min(1).openapi({ example: 'Revenue Analysis' }),
	description: z.string().openapi({ example: 'Monthly revenue breakdown' }),
	code: z.string().openapi({ example: 'import marimo as mo' }),
	tags: z
		.array(z.string())
		.optional()
		.openapi({ example: ['finance'] }),
	readme: z.string().optional(),
	deps: z.string().optional(),
	runtime: RuntimeResponseSchema.optional(),
	base_image: z
		.string()
		.min(1)
		.optional()
		.openapi({ example: 'ghcr.io/orgname/marimo-gpu:latest' }),
	compute_profile: z.string().min(1).optional().openapi({ example: 'large' }),
});

const CreateGitNotebookBody = z.object({
	title: z.string().min(1).openapi({ example: 'GitHub app' }),
	description: z.string().openapi({ example: 'Synced from a git repository' }),
	provider: z.string().min(1).optional().openapi({
		description:
			'Git provider id. Recognized repository hosts take precedence over this explicit claim.',
		example: 'github',
	}),
	// `owner/repo` (GitHub shorthand) or a repository URL.
	repo: z.string().min(1).openapi({ example: 'marimo-team/marimohub' }),
	branch: z.string().min(1).openapi({ example: 'main' }),
	// Repo subdirectory whose tree is mirrored; `entry_notebook` is relative to it.
	root_path: z.string().optional().openapi({ example: 'apps' }),
	entry_notebook: z.string().min(1).openapi({ example: 'my_app.py' }),
	tags: z
		.array(z.string())
		.optional()
		.openapi({ example: ['git'] }),
	readme: z.string().optional(),
	runtime: RuntimeResponseSchema.optional(),
	base_image: z.string().min(1).optional(),
	compute_profile: z.string().min(1).optional(),
	sync_mode: z.enum(['push', 'pull']).optional().default('push'),
});

const SyncTokenResponseSchema = z
	.object({
		sync_url: z.string(),
		sync_token: z.string(),
	})
	.openapi('SyncToken');

const GitNotebookCreateResponseSchema = z
	.object({
		notebook: NotebookMetaResponseSchema,
		sync_url: z.string().optional(),
		sync_token: z.string().optional(),
		sync_error: z.object({ code: z.string(), message: z.string() }).optional().openapi({
			description:
				'Initial pull failure. The draft notebook remains available and can be retried with Sync now.',
		}),
	})
	.openapi('GitNotebookCreateResult');

const UpdateGitSourceBody = z.object({
	repo: z.string().min(1).openapi({ example: 'marimo-team/marimohub' }),
	branch: z.string().min(1).openapi({ example: 'main' }),
	root_path: z.string().openapi({ example: 'apps' }),
	entry_notebook: z.string().min(1).openapi({ example: 'my_app.py' }),
	sync_mode: z.enum(['push', 'pull']).optional(),
});

const UpdateNotebookBody = z.object({
	title: z.string().min(1).optional(),
	description: z.string().optional(),
	code: z.string().optional(),
	tags: z.array(z.string()).optional(),
	readme: z.string().optional(),
	deps: z.string().optional(),
	message: z.string().optional().openapi({ example: 'Add regional breakdown' }),
	// null clears the choice back to the deployment default.
	base_image: z.string().min(1).nullable().optional(),
	// null clears the choice back to the deployment default.
	compute_profile: z.string().min(1).nullable().optional(),
});

const DuplicateNotebookBody = z.object({
	title: z.string().min(1).optional().openapi({ example: 'Revenue Analysis (copy)' }),
});

/**
 * Validate a requested base image against the deployment's configured list,
 * normalizing the literal `'default'` to `null` (= cleared choice, so it is
 * never persisted). Strict 400 here on the write path; session start is
 * deliberately lenient about already-stored values that fell off the list.
 */
function checkBaseImage(
	images: string[] | undefined,
	value: string | null | undefined,
): string | null | undefined {
	if (value === undefined || value === null) return value;
	if (value === 'default') return null;
	if (!images?.includes(value)) {
		throw new BadRequestError(
			images?.length
				? `Unknown base image "${value}"; valid options: default, ${images.join(', ')}`
				: 'This deployment does not offer base image selection',
		);
	}
	return value;
}

function checkComputeProfile(
	sandbox: SandboxConfig,
	value: string | null | undefined,
): string | null | undefined {
	if (value === undefined) return value;
	const profiles = sandbox.computeProfiles ?? [];
	if (sandbox.computeProfileOverride !== 'editors') {
		throw new ForbiddenError('This deployment does not allow compute profile selection');
	}
	if (value === null) return value;
	const known = profiles.some((profile) => profile.name === value);
	// Selecting the default clears the stored choice. `default` is the sentinel for
	// "deployment default"; it only clears when no configured profile is literally
	// named `default`, so such a profile stays selectable in its own right.
	if (value === profiles[0]?.name || (value === 'default' && !known)) return null;
	if (!known) {
		throw new BadRequestError(
			profiles.length > 0
				? `Unknown compute profile "${value}"; valid options: default, ${profiles.map((profile) => profile.name).join(', ')}`
				: 'This deployment does not offer compute profile selection',
		);
	}
	return value;
}

const VersionIdParam = NotebookIdParam.extend({
	vid: z
		.string()
		.regex(/^ver_[0-9A-Z]{26}$/)
		.refine(VersionId.is)
		.openapi({ param: { name: 'vid', in: 'path' }, example: 'ver_01HXYZ33333RSTUVWXYZAB' }),
});

// --- Route definitions ---

const listNotebooks = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks',
	tags: ['Notebooks'],
	summary: 'List notebooks in a project',
	request: { params: ProjectIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(SnapshotNotebookEntrySchema, 'NotebookPage'),
			}),
			'List of notebooks, newest first',
		),
		...commonErrors(),
		...errorResponses(400, 404),
	},
});

const createNotebook = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks',
	tags: ['Notebooks'],
	summary: 'Create a notebook',
	request: {
		params: ProjectIdParam,
		headers: IdempotencyKeyHeader,
		body: jsonBody(CreateNotebookBody),
	},
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: NotebookMetaResponseSchema }),
			'Notebook created',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const createGitNotebook = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/git',
	tags: ['Notebooks'],
	summary: 'Create a git-synced workspace notebook',
	request: { params: ProjectIdParam, body: jsonBody(CreateGitNotebookBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: GitNotebookCreateResponseSchema }),
			'Git-synced notebook created',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409),
	},
});

const rotateSyncToken = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sync-token/rotate',
	tags: ['Notebooks'],
	summary: 'Rotate a notebook sync token',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SyncTokenResponseSchema }),
			'Sync token rotated',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const updateGitSource = createRoute({
	method: 'patch',
	path: '/projects/{pid}/notebooks/{nid}/source',
	tags: ['Notebooks'],
	summary: 'Update a git-synced notebook source',
	request: { params: NotebookIdParam, body: jsonBody(UpdateGitSourceBody) },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ source: GitSourceResponseSchema }),
			}),
			'Git source updated',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409),
	},
});

const SourceDriftResponseSchema = z
	.object({
		current_commit: z.string().nullable().openapi({
			description: 'Commit of the last successful sync; null before the first sync.',
		}),
		remote_commit: z.string().openapi({
			description: 'Live head of the configured branch, resolved at request time.',
		}),
		in_sync: z.boolean(),
		pending_config: z.boolean().openapi({
			description: 'Whether a settings edit is waiting for a matching sync.',
		}),
		checked_at: z.iso.datetime(),
	})
	.openapi('SourceDrift');

const SourceSyncResponseSchema = z
	.object({
		synced: z.boolean().openapi({
			description: 'False when the notebook was already at the branch head.',
		}),
		commit: z.string(),
		version_id: z.string().nullable(),
	})
	.openapi('SourceSyncResult');

const getSourceDrift = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/source/drift',
	tags: ['Notebooks'],
	summary: 'Compare a git-synced notebook against its branch head',
	description:
		'Resolves the configured branch head via the server-side provider credential and reports ' +
		'whether the notebook is behind it. Stateless — nothing is stored. Requires a provider ' +
		'listed in `capabilities.source_control.sync_providers`.',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SourceDriftResponseSchema }),
			'Drift between the synced commit and the branch head',
		),
		...commonErrors(),
		...errorResponses(403, 404, 409),
	},
});

const syncSourceNow = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/source/sync',
	tags: ['Notebooks'],
	summary: 'Pull the branch head into a git-synced notebook',
	description:
		'Server-initiated sync: fetches the configured repository tree at the branch head and ' +
		'ingests it exactly like a pushed archive. A no-op when already at the head. Requires a ' +
		'provider listed in `capabilities.source_control.sync_providers`.',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SourceSyncResponseSchema }),
			'Sync outcome',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409),
	},
});

const getNotebook = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}',
	tags: ['Notebooks'],
	summary: 'Get notebook metadata',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: NotebookDetailResponseSchema }),
			'Notebook detail',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const getNotebookContent = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/content',
	tags: ['Notebooks'],
	summary: 'Get notebook code',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ code: z.string() }),
			}),
			'Notebook source code',
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const updateNotebook = createRoute({
	method: 'patch',
	path: '/projects/{pid}/notebooks/{nid}',
	tags: ['Notebooks'],
	summary: 'Update a notebook',
	request: { params: NotebookIdParam, headers: IfMatchHeader, body: jsonBody(UpdateNotebookBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: NotebookMetaResponseSchema }),
			'Notebook updated',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 409, 412),
	},
});

const deleteNotebook = createRoute({
	method: 'delete',
	path: '/projects/{pid}/notebooks/{nid}',
	tags: ['Notebooks'],
	summary: 'Delete a notebook (soft-delete)',
	request: { params: NotebookIdParam, headers: IfMatchHeader },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Notebook deleted'),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const listVersions = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/versions',
	tags: ['Notebooks'],
	summary: 'List notebook versions',
	request: { params: NotebookIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(NotebookVersionResponseSchema, 'NotebookVersionPage'),
			}),
			'List of versions, newest first',
		),
		...commonErrors(),
		...errorResponses(400, 404),
	},
});

const getVersion = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/versions/{vid}',
	tags: ['Notebooks'],
	summary: 'Get a specific version',
	request: { params: VersionIdParam },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ version: NotebookVersionResponseSchema, code: z.string() }),
			}),
			'Version details with code',
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const getNotebookHtml = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/html',
	tags: ['Notebooks'],
	summary: "Latest HTML snapshot of the notebook's outputs",
	description:
		"Serves the newest version's HTML snapshot (captured best-effort at session teardown) " +
		'raw — the static outputs shown to viewers under MARIMOHUB_VIEWER_MODE=static. ' +
		'`X-Marimohub-Version-Id` / `X-Marimohub-Captured-At` identify the snapshot. ' +
		'404 with code `NO_HTML_SNAPSHOT` when no version has one.',
	request: { params: NotebookIdParam },
	responses: {
		200: {
			content: { 'text/html': { schema: z.string() } },
			description: 'The HTML snapshot, served sandboxed (CSP forces an opaque origin)',
		},
		...commonErrors(),
		...errorResponses(404),
	},
});

const getVersionHtml = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/versions/{vid}/html',
	tags: ['Notebooks'],
	summary: "One version's HTML snapshot of the notebook's outputs",
	description:
		'Serves the HTML snapshot captured for this specific version, raw. ' +
		'404 with code `NO_HTML_SNAPSHOT` when the version captured none.',
	request: { params: VersionIdParam },
	responses: {
		200: {
			content: { 'text/html': { schema: z.string() } },
			description: 'The HTML snapshot, served sandboxed (CSP forces an opaque origin)',
		},
		...commonErrors(),
		...errorResponses(404),
	},
});

const restoreVersion = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/versions/{vid}/restore',
	tags: ['Notebooks'],
	summary: 'Restore a version as a new save',
	request: { params: VersionIdParam },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: NotebookMetaResponseSchema }),
			'Version restored as a new save; returns the updated notebook',
		),
		...commonErrors(),
		...errorResponses(403, 404, 409),
	},
});

const duplicateNotebook = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/duplicate',
	tags: ['Notebooks'],
	summary: 'Duplicate a notebook',
	request: {
		params: NotebookIdParam,
		headers: IdempotencyKeyHeader,
		body: jsonBody(DuplicateNotebookBody),
	},
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: NotebookMetaResponseSchema }),
			'Notebook duplicated; returns the new notebook',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

// --- App ---

const app = createApp();

function syncUrl(c: Context<HonoEnv>, pid: string, nid: string) {
	return `${new URL(c.req.url).origin}/api/sync/git/v1/projects/${pid}/notebooks/${nid}`;
}

app.openapi(listNotebooks, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectVisible(projects, pid, user, deps.policy);
	const all = await notebooks.listNotebooks(pid);
	const data = paginate(all, c.req.valid('query'), {
		key: (n) => n.created_at,
		tiebreak: (n) => n.id,
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(createNotebook, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'editor', deps.policy);
	const body = c.req.valid('json');
	const data = await idempotentCreate(c, 'POST /projects/{pid}/notebooks', async () => {
		// Validated inside the idempotency wrapper: a replay of a recorded create
		// returns the cached notebook even if the image list changed since.
		const base_image = checkBaseImage(deps.sandbox.images, body.base_image) ?? undefined;
		const compute_profile = checkComputeProfile(deps.sandbox, body.compute_profile) ?? undefined;
		const meta = await notebooks.createNotebook(
			pid,
			{ ...body, base_image, compute_profile },
			user.id,
		);
		return toPublicNotebookMeta(meta);
	});
	return c.json({ success: true, data }, 201);
});

app.openapi(createGitNotebook, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'editor', deps.policy);
	const body = c.req.valid('json');
	const base_image = checkBaseImage(deps.sandbox.images, body.base_image) ?? undefined;
	const compute_profile = checkComputeProfile(deps.sandbox, body.compute_profile) ?? undefined;
	const input = { ...body, base_image, compute_profile };
	const prospectiveSource = createGitSource(input);
	if (prospectiveSource.sync_mode === 'pull') {
		assertPullSourceSupported(deps, prospectiveSource);
	}
	const { meta, sync_token } = await notebooks.synced.create(pid, input, user.id);
	let syncError: { code: string; message: string } | undefined;
	if (prospectiveSource.sync_mode === 'pull') {
		try {
			const outcome = await pullSourceToHead(deps, pid, meta.id, user.id);
			if (outcome.synced) {
				await appendAudit(
					{
						requestId: c.get('requestId'),
						method: c.req.method,
						path: c.req.path,
						userId: user.id,
					},
					'notebook.source.sync',
					() =>
						deps.services.events.append({
							event: 'notebook.source.sync',
							actor: user.id,
							project_id: pid,
							notebook_id: meta.id,
							commit: outcome.commit,
							trigger: 'create',
						}),
				);
			}
		} catch (error) {
			syncError =
				error instanceof DomainError
					? { code: error.code, message: error.message }
					: { code: 'SYNC_FAILED', message: 'The initial repository sync failed' };
		}
	}
	const createdMeta =
		prospectiveSource.sync_mode === 'pull'
			? await notebooks
					.getNotebook(pid, meta.id)
					.then(({ meta: refreshedMeta }) => refreshedMeta)
					.catch(() => meta)
			: meta;
	return c.json(
		{
			success: true,
			data: {
				notebook: toPublicNotebookMeta(createdMeta),
				...(sync_token ? { sync_url: syncUrl(c, pid, meta.id), sync_token } : {}),
				...(syncError ? { sync_error: syncError } : {}),
			},
		},
		201,
	);
});

app.openapi(rotateSyncToken, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'editor', deps.policy);
	const { sync_token } = await notebooks.synced.rotateToken(pid, nid);
	return c.json({ success: true, data: { sync_url: syncUrl(c, pid, nid), sync_token } }, 200);
});

app.openapi(updateGitSource, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'editor', deps.policy);
	const input = c.req.valid('json');
	const current = assertSyncedSource((await notebooks.getNotebook(pid, nid)).source);
	const prospective = applyGitSourceUpdate(current, input) ?? current;
	if (current.sync_mode === 'pull') assertPullSourceSupported(deps, prospective);
	const source = await notebooks.synced.updateSource(pid, nid, input, user.id);
	const { schema_version: _schemaVersion, ...publicSource } = source;
	return c.json({ success: true, data: { source: publicSource } }, 200);
});

app.openapi(getSourceDrift, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'editor', deps.policy);
	const { source } = await notebooks.getNotebook(pid, nid);
	const { git, head } = await resolveSyncTarget(deps, source);
	return c.json(
		{ success: true, data: sourceDrift(git, head.commit, new Date().toISOString()) },
		200,
	);
});

app.openapi(syncSourceNow, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'editor', deps.policy);
	const outcome = await pullSourceToHead(deps, pid, nid, user.id);
	if (outcome.synced) {
		await appendAudit(
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
			'notebook.source.sync',
			() =>
				deps.services.events.append({
					event: 'notebook.source.sync',
					actor: user.id,
					project_id: pid,
					notebook_id: nid,
					commit: outcome.commit,
					trigger: 'manual',
				}),
		);
	}
	return c.json({ success: true, data: outcome }, 200);
});

app.openapi(getNotebook, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectVisible(projects, pid, user, deps.policy);
	const detail = await notebooks.getNotebook(pid, nid);
	const data = {
		meta: toPublicNotebookMeta(detail.meta),
		readme: detail.readme,
		source: toPublicSource(detail.source),
	};
	c.header('ETag', etagFor(detail.meta.updated_at));
	return c.json({ success: true, data }, 200);
});

app.openapi(getNotebookContent, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectVisible(projects, pid, user, deps.policy);
	const code = await notebooks.getNotebookContent(pid, nid);
	return c.json({ success: true, data: { code } }, 200);
});

app.openapi(updateNotebook, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'editor', deps.policy);
	const body = c.req.valid('json');
	const base_image = checkBaseImage(deps.sandbox.images, body.base_image);
	const compute_profile = checkComputeProfile(deps.sandbox, body.compute_profile);
	const meta = await notebooks.updateNotebook(
		pid,
		nid,
		{ ...body, base_image, compute_profile },
		user.id,
		ifMatchToken(c),
	);
	c.header('ETag', etagFor(meta.updated_at));
	return c.json({ success: true, data: toPublicNotebookMeta(meta) }, 200);
});

app.openapi(deleteNotebook, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await assertProjectRole(projects, pid, user, 'editor', deps.policy);
	const deleted = await notebooks.deleteNotebookWithMutation(pid, nid, user.id, ifMatchToken(c));
	if (deleted) {
		scheduleProjectAlert(deps, pid, 'notebook.deleted', { project_id: pid, user: user.id }, () =>
			notificationRouter.render({
				kind: 'notebook.deleted',
				project,
				notebookId: nid,
				notebookTitle: deleted.notebook.title,
				actor: user,
				mutationId: deleted.mutationId,
				baseUrl: deps.sandbox.appBaseUrl,
			}),
		);
	}

	await retireLiveApps(deps, pid, (s) => s.notebook_id === nid);

	return c.json({ success: true }, 200);
});

app.openapi(listVersions, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectVisible(projects, pid, user, deps.policy);
	const all = await notebooks.listVersions(pid, nid);
	const page = paginate(all, c.req.valid('query'), {
		key: (v) => v.saved_at,
		tiebreak: (v) => v.version_id,
	});
	const data = { ...page, items: page.items.map(toPublicVersion) };
	return c.json({ success: true, data }, 200);
});

app.openapi(getVersion, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, vid } = c.req.valid('param');
	await assertProjectVisible(projects, pid, user, deps.policy);
	const { version, code } = await notebooks.getVersion(pid, nid, vid);
	return c.json({ success: true, data: { version: toPublicVersion(version), code } }, 200);
});

/**
 * Serve an HTML snapshot. The snapshot is user-generated HTML (marimo's export
 * embeds scripts) and must never execute same-origin with the app. CSP
 * `sandbox` forces an opaque origin even when the URL is opened directly,
 * independent of the client's own <iframe sandbox> — two independent
 * containment layers. Authenticated content is never disk-cached (a shared
 * machine must not serve a private notebook's outputs after logout).
 */
function serveHtmlSnapshot(
	c: Context<HonoEnv>,
	snapshot: { versionId: string; capturedAt: string; html: string } | null,
) {
	if (!snapshot) {
		return fail(c, 'NO_HTML_SNAPSHOT', 'No HTML snapshot has been captured yet', 404);
	}
	c.header('Content-Security-Policy', 'sandbox allow-scripts');
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('Cache-Control', 'private, no-store');
	c.header('X-Marimohub-Version-Id', snapshot.versionId);
	c.header('X-Marimohub-Captured-At', snapshot.capturedAt);
	return c.html(snapshot.html, 200);
}

app.openapi(getNotebookHtml, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	// Read-only, gated like reading the notebook's code (viewer visibility).
	await assertProjectVisible(projects, pid, user, deps.policy);
	// The existence gate (404 on a missing notebook) and the snapshot fetch are
	// independent reads, so they overlap; only getNotebook throws NotFoundError.
	const [, snapshot] = await Promise.all([
		notebooks.getNotebook(pid, nid),
		notebooks.getLatestHtmlSnapshot(pid, nid),
	]);
	return serveHtmlSnapshot(c, snapshot);
});

app.openapi(getVersionHtml, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, vid } = c.req.valid('param');
	await assertProjectVisible(projects, pid, user, deps.policy);
	const snapshot = await notebooks.getVersionHtmlSnapshot(pid, nid, vid);
	return serveHtmlSnapshot(c, snapshot);
});

app.openapi(restoreVersion, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, vid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'editor', deps.policy);
	const meta = await notebooks.restoreVersion(pid, nid, vid, user.id);
	return c.json({ success: true, data: toPublicNotebookMeta(meta) }, 201);
});

app.openapi(duplicateNotebook, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'editor', deps.policy);
	const body = c.req.valid('json');
	const data = await idempotentCreate(
		c,
		'POST /projects/{pid}/notebooks/{nid}/duplicate',
		async () => {
			const meta = await notebooks.duplicateNotebook(pid, nid, user.id, body.title);
			return toPublicNotebookMeta(meta);
		},
	);
	return c.json({ success: true, data }, 201);
});

// GET .../workspace.zip — download the notebook's `workspace/` mirror as a zip.
// A plain Hono route (not `app.openapi`) because the body is binary, not the
// `{success,data}` JSON envelope — keeping it out of the OpenAPI doc avoids
// generating an unusable binary method in the typed client. Auth/CSRF/init
// middleware still apply (it is mounted under `/api`). Read-only, like the other
// notebook GETs, so gated only at `viewer` (visibility) like them.
//
// The whole workspace is read into memory and zipped synchronously (`zipSync`).
// Workspaces are small (notebook + data files), so this is fine; `zipSync` is
// preferred over the async `zip()` because the latter's Worker path is unreliable
// in the bundled, no-`node_modules` server image.
app.get('/projects/:pid/notebooks/:nid/workspace.zip', async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const pidRaw = c.req.param('pid');
	const nidRaw = c.req.param('nid');
	if (!ProjectId.is(pidRaw) || !NotebookId.is(nidRaw)) {
		throw new NotFoundError('Notebook not found');
	}
	await assertProjectVisible(projects, pidRaw, user, deps.policy);

	const files = await notebooks.listWorkspaceFiles(pidRaw, nidRaw);
	const zipped = zipSync(Object.fromEntries(files.map((f) => [f.path, f.bytes])));

	return new Response(zipped, {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': 'attachment; filename="workspace.zip"',
		},
	});
});

export default app;
