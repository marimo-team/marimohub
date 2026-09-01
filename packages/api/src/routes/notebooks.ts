import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { zipSync } from 'fflate';
import {
	applyGitSourceUpdate,
	assertSyncedSource,
	BadRequestError,
	ConflictError,
	createGitSource,
	DomainError,
	effectiveRole,
	ForbiddenError,
	joinUrlPath,
	NotebookId,
	NotFoundError,
	MAX_WORKSPACE_FILE_BYTES,
	notificationRouter,
	ProjectId,
	roleAtLeast,
	sessionMode,
	sourceDrift,
	isMonotonicRestrictionIncrease,
	toPublicNotebookMeta,
	ValidationError,
	toPublicSource,
	toPublicVersion,
	VersionId,
} from '@marimo-hub/core';
import type { WorkspaceFileItem } from '@marimo-hub/core';
import {
	assertProjectActionOn,
	assertSessionAuthenticated,
	SecurityLabelsBodySchema,
	SESSION_ONLY_SECURITY,
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
	loadAuthorizedNotebook,
	loadVisibleProject,
	GitSourceResponseSchema,
	NotebookDetailResponseSchema,
	NotebookIdParam,
	NotebookMetaResponseSchema,
	ProjectIdParam,
	resolvePublicBaseUrl,
	RuntimeResponseSchema,
	NotebookVersionResponseSchema,
	retireLiveApps,
	SnapshotNotebookEntrySchema,
	SuccessResponseSchema,
} from '../shared';
import { idempotentCreate } from '../idempotency';
import { appendAudit } from '../log';
import { objectContentDisposition } from '../contentDisposition';
import { assertPullSourceSupported, pullSourceToHead, resolveSyncTarget } from './sourcePullSync';
import type { HonoEnv, SandboxConfig } from '../context';
import { NotebookListQuery, pageSchema, paginate, PaginationQuery } from '../pagination';
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

const WorkspaceItemSchema = z
	.object({
		path: z.string(),
		name: z.string(),
		kind: z.enum(['file', 'directory']),
		size: z.number().int().nonnegative().optional(),
		modified_at: z.number().int().nonnegative().optional(),
		mime_type: z.string().optional(),
	})
	.openapi('WorkspaceItem');

const WorkspacePathQuery = z.object({ path: z.string().optional().default('/') });
const WorkspaceListQuery = WorkspacePathQuery.extend({ cursor: z.string().optional() });
const WorkspaceSearchQuery = WorkspacePathQuery.extend({ query: z.string().min(1) });
const WorkspaceFilePathQuery = z.object({ path: z.string().min(1) });
const WorkspaceFileQuery = WorkspaceFilePathQuery.extend({
	create: z.enum(['true', 'false']).optional(),
});
const WorkspaceDirectoryBody = z.object({ path: z.string().min(1) });
const WorkspaceTransferBody = z.object({ from: z.string().min(1), to: z.string().min(1) });

const WorkspaceAccessSchema = z
	.object({
		writable: z.boolean(),
		read_only_reason: z.enum(['git_source', 'viewer', 'active_session']).nullable(),
		protected_paths: z.array(
			z.object({
				path: z.string(),
				denied_operations: z.array(z.enum(['create', 'write', 'move', 'copy', 'delete'])),
			}),
		),
	})
	.openapi('WorkspaceAccess');
const WorkspaceFileBinary = z.string().openapi({ format: 'binary' });

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
	operationId: 'notebooks.list',
	tags: ['Notebooks'],
	summary: 'List notebooks in a project',
	description: 'When paging a filtered list, send the same filters with each cursor.',
	request: { params: ProjectIdParam, query: NotebookListQuery },
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
	operationId: 'notebooks.create',
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
	operationId: 'notebooks.create-git',
	tags: ['Notebooks'],
	summary: 'Create a git-synced workspace notebook',
	description: 'Requires project manager access because this selects a server-side repository.',
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
	operationId: 'notebooks.rotate-sync-token',
	'x-cli-destructive': true,
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
	operationId: 'notebooks.update-source',
	tags: ['Notebooks'],
	summary: 'Update a git-synced notebook source',
	description: 'Requires project manager access because this changes the server-side repository.',
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
	operationId: 'notebooks.source.drift',
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
	operationId: 'notebooks.source.sync',
	'x-cli-destructive': true,
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
	operationId: 'notebooks.get',
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
	operationId: 'notebooks.content',
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
	operationId: 'notebooks.update',
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

const setNotebookSecurityLabels = createRoute({
	method: 'put',
	path: '/projects/{pid}/notebooks/{nid}/security-labels',
	operationId: 'notebooks.securityLabels.set',
	tags: ['Notebooks'],
	summary: 'Set a notebook security-label override',
	description:
		'Sets an override enforced IN ADDITION to the project labels, so it can only add ' +
		'restrictions. Requires super-admin standing — no project role grants label authority.',
	security: SESSION_ONLY_SECURITY,
	request: { params: NotebookIdParam, body: jsonBody(SecurityLabelsBodySchema) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: NotebookMetaResponseSchema }),
			'Security labels updated',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const clearNotebookSecurityLabels = createRoute({
	method: 'delete',
	path: '/projects/{pid}/notebooks/{nid}/security-labels',
	operationId: 'notebooks.securityLabels.clear',
	tags: ['Notebooks'],
	summary: 'Remove a notebook security-label override',
	security: SESSION_ONLY_SECURITY,
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: NotebookMetaResponseSchema }),
			'Security labels removed',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const deleteNotebook = createRoute({
	method: 'delete',
	path: '/projects/{pid}/notebooks/{nid}',
	operationId: 'notebooks.delete',
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
	operationId: 'notebooks.versions.list',
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
	operationId: 'notebooks.versions.get',
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
	operationId: 'notebooks.html',
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
	operationId: 'notebooks.versions.html',
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
	operationId: 'notebooks.versions.restore',
	'x-cli-destructive': true,
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
	operationId: 'notebooks.duplicate',
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

const getWorkspaceAccess = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/workspace/access',
	operationId: 'notebooks.workspace.access',
	tags: ['Notebooks'],
	summary: 'Get workspace file capabilities',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: WorkspaceAccessSchema }),
			'Workspace access policy',
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const listWorkspaceEntries = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/workspace/entries',
	operationId: 'notebooks.workspace.list',
	tags: ['Notebooks'],
	summary: 'List a workspace directory',
	request: { params: NotebookIdParam, query: WorkspaceListQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ items: z.array(WorkspaceItemSchema), cursor: z.string().optional() }),
			}),
			'Workspace entries',
		),
		...commonErrors(),
		...errorResponses(400, 404),
	},
});

const searchWorkspace = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/workspace/search',
	operationId: 'notebooks.workspace.search',
	tags: ['Notebooks'],
	summary: 'Search workspace paths',
	request: { params: NotebookIdParam, query: WorkspaceSearchQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ items: z.array(WorkspaceItemSchema) }),
			}),
			'Workspace search results',
		),
		...commonErrors(),
		...errorResponses(400, 404),
	},
});

const createWorkspaceDirectory = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/workspace/directories',
	operationId: 'notebooks.workspace.directories.create',
	tags: ['Notebooks'],
	summary: 'Create a workspace directory',
	request: { params: NotebookIdParam, body: jsonBody(WorkspaceDirectoryBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: WorkspaceItemSchema }),
			'Workspace directory created',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409),
	},
});

const deleteWorkspaceEntry = createRoute({
	method: 'delete',
	path: '/projects/{pid}/notebooks/{nid}/workspace/entries',
	operationId: 'notebooks.workspace.delete',
	'x-cli-destructive': true,
	tags: ['Notebooks'],
	summary: 'Delete a workspace entry',
	request: { params: NotebookIdParam, query: WorkspaceFilePathQuery },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Workspace entry deleted'),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409),
	},
});

function workspaceTransferRoute(action: 'move' | 'copy') {
	return createRoute({
		method: 'post',
		path: `/projects/{pid}/notebooks/{nid}/workspace/${action}`,
		operationId: `notebooks.workspace.${action}`,
		...(action === 'move' ? { 'x-cli-destructive': true as const } : {}),
		tags: ['Notebooks'],
		summary: `${action === 'move' ? 'Move' : 'Copy'} a workspace entry`,
		request: { params: NotebookIdParam, body: jsonBody(WorkspaceTransferBody) },
		responses: {
			200: jsonContent(
				z.object({ success: z.literal(true), data: WorkspaceItemSchema }),
				`Workspace entry ${action === 'move' ? 'moved' : 'copied'}`,
			),
			...commonErrors(),
			...errorResponses(400, 403, 404, 409),
		},
	});
}

const moveWorkspaceEntry = workspaceTransferRoute('move');
const copyWorkspaceEntry = workspaceTransferRoute('copy');

const readWorkspaceFile = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/workspace/files',
	operationId: 'notebooks.workspace.files.read',
	'x-cli-hidden': true,
	tags: ['Notebooks'],
	summary: 'Read raw workspace file content',
	request: { params: NotebookIdParam, query: WorkspaceFilePathQuery },
	responses: {
		200: {
			content: { '*/*': { schema: WorkspaceFileBinary } },
			description: 'Raw workspace file bytes',
		},
		...commonErrors(),
		...errorResponses(400, 404),
	},
});

const writeWorkspaceFile = createRoute({
	method: 'put',
	path: '/projects/{pid}/notebooks/{nid}/workspace/files',
	operationId: 'notebooks.workspace.files.write',
	'x-cli-hidden': true,
	tags: ['Notebooks'],
	summary: 'Create or overwrite a workspace file',
	request: {
		params: NotebookIdParam,
		query: WorkspaceFileQuery,
		body: {
			required: true,
			content: { 'application/octet-stream': { schema: WorkspaceFileBinary } },
		},
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: WorkspaceItemSchema }),
			'Workspace file saved',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409),
	},
});

// --- App ---

const app = createApp();

// Register raw content contracts without attaching the OpenAPI request parser.
app.openAPIRegistry.registerPath(readWorkspaceFile);
app.openAPIRegistry.registerPath(writeWorkspaceFile);

function toWorkspaceItem(item: WorkspaceFileItem) {
	return {
		path: `/${item.path}`,
		name: item.name,
		kind: item.kind,
		...(item.size === undefined ? {} : { size: item.size }),
		...(item.modifiedAt === undefined ? {} : { modified_at: item.modifiedAt }),
		...(item.mimeType === undefined ? {} : { mime_type: item.mimeType }),
	};
}

async function workspaceState(
	c: Context<HonoEnv>,
	pid: ProjectId,
	nid: NotebookId,
	mutation: boolean,
) {
	const deps = c.get('deps');
	const user = c.get('user');
	const { notebooks, projects, sessions } = deps.services;
	const [project, active] = await Promise.all([
		mutation
			? assertProjectRole(projects, pid, user, 'notebook.write', deps)
			: loadVisibleProject(projects, pid, user, deps),
		sessions.listActiveByProject(pid),
	]);
	const editorActive = active.some(
		(session) => session.notebook_id === nid && sessionMode(session) === 'edit',
	);
	const role = effectiveRole(project, user, deps.policy);
	const sourceAccess = await notebooks.workspace.access(pid, nid);
	const readOnlyReason = !sourceAccess.writable
		? ('git_source' as const)
		: !roleAtLeast(role, 'editor')
			? ('viewer' as const)
			: editorActive
				? ('active_session' as const)
				: null;
	if (mutation && editorActive) {
		throw new ConflictError('Workspace files cannot be changed while an edit session is active');
	}
	return {
		writable: readOnlyReason === null,
		readOnlyReason,
		protectedPaths: sourceAccess.protectedPaths,
	};
}

app.openapi(getWorkspaceAccess, async (c) => {
	const { pid, nid } = c.req.valid('param');
	const state = await workspaceState(c, pid, nid, false);
	return c.json(
		{
			success: true,
			data: {
				writable: state.writable,
				read_only_reason: state.readOnlyReason,
				protected_paths: state.protectedPaths.map((rule) => ({
					path: `/${rule.path}`,
					denied_operations: [...rule.deniedOperations],
				})),
			},
		},
		200,
	);
});

app.openapi(listWorkspaceEntries, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	{
		const project = await loadVisibleProject(deps.services.projects, pid, user, deps);
		await loadAuthorizedNotebook(deps, project, nid, user);
	}
	const query = c.req.valid('query');
	const result = await deps.services.notebooks.workspace.list(pid, nid, query.path, query.cursor);
	return c.json(
		{
			success: true,
			data: {
				items: result.items.map(toWorkspaceItem),
				...(result.cursor ? { cursor: result.cursor } : {}),
			},
		},
		200,
	);
});

app.openapi(searchWorkspace, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	{
		const project = await loadVisibleProject(deps.services.projects, pid, user, deps);
		await loadAuthorizedNotebook(deps, project, nid, user);
	}
	const query = c.req.valid('query');
	const items = await deps.services.notebooks.workspace.search(pid, nid, query.query, query.path);
	return c.json({ success: true, data: { items: items.map(toWorkspaceItem) } }, 200);
});

app.openapi(createWorkspaceDirectory, async (c) => {
	const deps = c.get('deps');
	const { pid, nid } = c.req.valid('param');
	await workspaceState(c, pid, nid, true);
	const item = await deps.services.notebooks.workspace.createDirectory(
		pid,
		nid,
		c.req.valid('json').path,
	);
	return c.json({ success: true, data: toWorkspaceItem(item) }, 201);
});

app.openapi(deleteWorkspaceEntry, async (c) => {
	const deps = c.get('deps');
	const { pid, nid } = c.req.valid('param');
	await workspaceState(c, pid, nid, true);
	await deps.services.notebooks.workspace.delete(pid, nid, c.req.valid('query').path);
	return c.json({ success: true }, 200);
});

app.openapi(moveWorkspaceEntry, async (c) => {
	const deps = c.get('deps');
	const { pid, nid } = c.req.valid('param');
	await workspaceState(c, pid, nid, true);
	const body = c.req.valid('json');
	const item = await deps.services.notebooks.workspace.move(pid, nid, body.from, body.to);
	return c.json({ success: true, data: toWorkspaceItem(item) }, 200);
});

app.openapi(copyWorkspaceEntry, async (c) => {
	const deps = c.get('deps');
	const { pid, nid } = c.req.valid('param');
	await workspaceState(c, pid, nid, true);
	const body = c.req.valid('json');
	const item = await deps.services.notebooks.workspace.copy(pid, nid, body.from, body.to);
	return c.json({ success: true, data: toWorkspaceItem(item) }, 200);
});

app.get('/projects/:pid/notebooks/:nid/workspace/files', async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const pid = c.req.param('pid');
	const nid = c.req.param('nid');
	if (!ProjectId.is(pid) || !NotebookId.is(nid)) throw new NotFoundError('Notebook not found');
	const path = c.req.query('path');
	if (!path) throw new BadRequestError('path is required');
	{
		const project = await loadVisibleProject(deps.services.projects, pid, user, deps);
		await loadAuthorizedNotebook(deps, project, nid, user);
	}
	const file = await deps.services.notebooks.workspace.read(pid, nid, path);
	return new Response(new Uint8Array(file.bytes), {
		headers: {
			'cache-control': 'private, no-store',
			'content-disposition': objectContentDisposition(file.item.name, false),
			'content-type': file.item.mimeType ?? 'application/octet-stream',
			'x-content-type-options': 'nosniff',
		},
	});
});

app.put('/projects/:pid/notebooks/:nid/workspace/files', async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const pid = c.req.param('pid');
	const nid = c.req.param('nid');
	if (!ProjectId.is(pid) || !NotebookId.is(nid)) throw new NotFoundError('Notebook not found');
	const path = c.req.query('path');
	if (!path) throw new BadRequestError('path is required');
	const create = c.req.query('create');
	if (create !== undefined && create !== 'true' && create !== 'false') {
		throw new BadRequestError('create must be true or false');
	}
	await workspaceState(c, pid, nid, true);
	const declaredSize = Number(c.req.header('content-length'));
	if (Number.isFinite(declaredSize) && declaredSize > MAX_WORKSPACE_FILE_BYTES) {
		return fail(
			c,
			'PAYLOAD_TOO_LARGE',
			`Workspace file exceeds the ${MAX_WORKSPACE_FILE_BYTES}-byte limit`,
			413,
		);
	}
	const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
	const item = await deps.services.notebooks.workspace.write(
		pid,
		nid,
		path,
		bytes,
		user.id,
		create === 'true',
	);
	return c.json({ success: true, data: toWorkspaceItem(item) }, 200);
});

function syncUrl(c: Context<HonoEnv>, pid: string, nid: string) {
	return joinUrlPath(
		resolvePublicBaseUrl(c, c.get('deps').sandbox.appBaseUrl),
		`/api/sync/git/v1/projects/${pid}/notebooks/${nid}`,
	);
}

app.openapi(listNotebooks, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const query = c.req.valid('query');
	await assertProjectVisible(projects, pid, user, deps);
	const all = await notebooks.listNotebooks(pid, {
		status: query.status,
		tag: query.tag,
		q: query.q,
		subject: user,
		policy: deps.policy,
		resourceSecurity: deps.resourceSecurity,
	});
	const data = paginate(all, query, {
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
	await assertProjectRole(projects, pid, user, 'notebook.write', deps);
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
	const project = await assertProjectRole(projects, pid, user, 'notebook.manage', deps);
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
			const outcome = await pullSourceToHead(deps, project, meta.id, user.id, user);
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
	await assertProjectRole(projects, pid, user, 'notebook.write', deps);
	const { sync_token } = await notebooks.synced.rotateToken(pid, nid);
	return c.json({ success: true, data: { sync_url: syncUrl(c, pid, nid), sync_token } }, 200);
});

app.openapi(updateGitSource, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await assertProjectRole(projects, pid, user, 'notebook.manage', deps);
	const input = c.req.valid('json');
	const current = assertSyncedSource(
		(await loadAuthorizedNotebook(deps, project, nid, user)).source,
	);
	const prospective = applyGitSourceUpdate(current, input) ?? current;
	if (current.sync_mode === 'pull') assertPullSourceSupported(deps, prospective);
	const source = await notebooks.synced.updateSource(pid, nid, input, user.id);
	const { schema_version: _schemaVersion, ...publicSource } = source;
	return c.json({ success: true, data: { source: publicSource } }, 200);
});

app.openapi(getSourceDrift, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await assertProjectRole(projects, pid, user, 'notebook.write', deps);
	const { source } = await loadAuthorizedNotebook(deps, project, nid, user);
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
	const project = await assertProjectRole(projects, pid, user, 'notebook.write', deps);
	const outcome = await pullSourceToHead(deps, project, nid, user.id, user);
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
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await loadVisibleProject(projects, pid, user, deps);
	const detail = await loadAuthorizedNotebook(deps, project, nid, user);
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
	const project = await loadVisibleProject(projects, pid, user, deps);
	await loadAuthorizedNotebook(deps, project, nid, user);
	const code = await notebooks.getNotebookContent(pid, nid);
	return c.json({ success: true, data: { code } }, 200);
});

/**
 * Shared handler for the notebook label mutations. Same raise/lower selection
 * as the project flow; removing an override is a lower (it relaxes the
 * effective restriction back to the project labels alone).
 */
async function mutateNotebookSecurityLabels(
	c: Parameters<Parameters<typeof app.openapi>[1]>[0],
	labels: { classification: string; compartments: string[] } | undefined,
) {
	const deps = c.get('deps');
	const user = c.get('user');
	const pid = ProjectId.parse(c.req.param('pid') ?? '');
	const nid = NotebookId.parse(c.req.param('nid') ?? '');
	assertSessionAuthenticated(c, 'change security labels');
	if (labels !== undefined && deps.resourceSecurity === undefined) {
		throw new ValidationError(
			'Security labels require resource security to be configured (MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER); ' +
				'labels without an evaluator would lock the notebook for everyone.',
		);
	}
	const project = await deps.services.projects.getProject(pid);
	const existing = await deps.services.notebooks.getNotebook(pid, nid);
	if (existing.meta.status === 'deleted') throw new NotFoundError(`Notebook ${nid} not found`);
	const previous = existing.meta.security_labels;
	const action =
		previous === undefined
			? 'security-labels.raise'
			: labels !== undefined && isMonotonicRestrictionIncrease(previous, labels)
				? 'security-labels.raise'
				: 'security-labels.lower';
	await assertProjectActionOn(project, user, action, deps);
	const meta = await deps.services.notebooks.setSecurityLabels(pid, nid, labels, user.id);
	c.header('ETag', etagFor(meta.updated_at));
	return c.json({ success: true, data: toPublicNotebookMeta(meta) }, 200);
}

app.openapi(setNotebookSecurityLabels, async (c) =>
	mutateNotebookSecurityLabels(c, c.req.valid('json')),
);

app.openapi(clearNotebookSecurityLabels, async (c) => mutateNotebookSecurityLabels(c, undefined));

app.openapi(updateNotebook, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'notebook.write', deps);
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
	const project = await assertProjectRole(projects, pid, user, 'notebook.write', deps);
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
	const project = await loadVisibleProject(projects, pid, user, deps);
	await loadAuthorizedNotebook(deps, project, nid, user);
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
	const project = await loadVisibleProject(projects, pid, user, deps);
	await loadAuthorizedNotebook(deps, project, nid, user);
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
	const project = await loadVisibleProject(projects, pid, user, deps);
	await loadAuthorizedNotebook(deps, project, nid, user);
	const snapshot = await notebooks.getLatestHtmlSnapshot(pid, nid);
	return serveHtmlSnapshot(c, snapshot);
});

app.openapi(getVersionHtml, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, vid } = c.req.valid('param');
	const project = await loadVisibleProject(projects, pid, user, deps);
	await loadAuthorizedNotebook(deps, project, nid, user);
	const snapshot = await notebooks.getVersionHtmlSnapshot(pid, nid, vid);
	return serveHtmlSnapshot(c, snapshot);
});

app.openapi(restoreVersion, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, vid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'notebook.write', deps);
	const meta = await notebooks.restoreVersion(pid, nid, vid, user.id);
	return c.json({ success: true, data: toPublicNotebookMeta(meta) }, 201);
});

app.openapi(duplicateNotebook, async (c) => {
	const deps = c.get('deps');
	const { notebooks, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'notebook.write', deps);
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
	{
		const project = await loadVisibleProject(projects, pidRaw, user, deps);
		await loadAuthorizedNotebook(deps, project, nidRaw, user);
	}

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
