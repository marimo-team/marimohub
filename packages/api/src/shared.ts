import { OpenAPIHono, z } from '@hono/zod-openapi';
import { requireRole, type ProjectId, type ProjectService, type Role } from '@marimo-hub/core';
import type { HonoEnv } from './context';

// Re-export the injected-context types for route modules that import from './shared'.
export type { ApiDeps, HonoEnv } from './context';

/**
 * Enforce that `userId` holds at least `min` role on the project. Loads
 * `project.json` (404 if the project does not exist) and throws ForbiddenError
 * (403) on insufficient role. Used to gate write routes; reads are open in v1.
 */
export async function assertProjectRole(
	projects: ProjectService,
	pid: ProjectId,
	userId: string,
	min: Role,
): Promise<void> {
	const project = await projects.getProject(pid);
	requireRole(project, userId, min);
}

export function createApp() {
	return new OpenAPIHono<HonoEnv>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					{
						success: false as const,
						error: {
							code: 'VALIDATION_ERROR',
							message: result.error.issues
								.map((i) => `${i.path.join('.')}: ${i.message}`)
								.join(', '),
						},
					},
					422,
				);
			}
		},
	});
}

// --- Helpers ---

const dt = () => z.string().openapi({ format: 'date-time', example: '2025-03-05T14:00:00Z' });

export function jsonContent<T extends z.ZodType>(schema: T, description: string) {
	return {
		content: { 'application/json': { schema } },
		description,
	};
}

export function jsonBody<T extends z.ZodType>(schema: T) {
	return {
		content: { 'application/json': { schema } },
		required: true as const,
	};
}

// --- Path param schemas ---

export const ProjectIdParam = z.object({
	pid: z
		.string()
		.regex(/^proj-[0-9a-z]{16}$/)
		.openapi({
			param: { name: 'pid', in: 'path' },
			example: 'proj-7h2k9qm4xz7rp3w8',
		}),
});

export const NotebookIdParam = ProjectIdParam.extend({
	nid: z
		.string()
		.regex(/^nb-[0-9a-z]{16}$/)
		.openapi({
			param: { name: 'nid', in: 'path' },
			example: 'nb-3w8h2k9qm4xz7rp3',
		}),
});

export const SessionIdParam = NotebookIdParam.extend({
	sid: z
		.string()
		.regex(/^sess-[0-9a-z]{16}$/)
		.openapi({
			param: { name: 'sid', in: 'path' },
			example: 'sess-9qm4xz7rp3w8h2k9',
		}),
});

export const SandboxIdParam = z.object({
	id: z.string().openapi({
		param: { name: 'id', in: 'path' },
		example: 'a1b2c3d4',
	}),
});

// --- Shared response schemas ---

export const ErrorResponseSchema = z
	.object({
		success: z.literal(false),
		error: z.object({
			code: z.string(),
			message: z.string(),
		}),
	})
	.openapi('ErrorResponse');

export const SuccessResponseSchema = z
	.object({
		success: z.literal(true),
	})
	.openapi('SuccessResponse');

// --- Domain response schemas for OpenAPI docs ---

export const ProjectMemberResponseSchema = z
	.object({
		user_id: z.string(),
		role: z.enum(['admin', 'editor', 'viewer']),
	})
	.openapi('ProjectMember');

export const ProjectResponseSchema = z
	.object({
		schema_version: z.literal(1),
		id: z.string(),
		name: z.string(),
		description: z.string(),
		owner: z.string(),
		members: z.array(ProjectMemberResponseSchema),
		created_at: dt(),
		updated_at: dt(),
		tags: z.array(z.string()),
	})
	.openapi('Project');

export const SnapshotNotebookEntrySchema = z
	.object({
		id: z.string(),
		title: z.string(),
		description: z.string(),
		status: z.enum(['draft', 'active', 'archived', 'deleted']),
		source_type: z.enum(['local', 'github']),
		author: z.string(),
		created_at: dt(),
		updated_at: dt(),
		tags: z.array(z.string()),
		last_run_at: z.string().nullable(),
	})
	.openapi('SnapshotNotebookEntry');

export const SnapshotProjectEntrySchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string(),
		owner: z.string(),
		created_at: dt(),
		updated_at: dt(),
		notebook_count: z.number(),
		notebooks: z.array(SnapshotNotebookEntrySchema),
	})
	.openapi('SnapshotProjectEntry');

export const RuntimeResponseSchema = z.object({
	python_version: z.string().optional(),
	marimo_version: z.string().optional(),
});

export const NotebookMetaResponseSchema = z
	.object({
		schema_version: z.literal(1),
		id: z.string(),
		project_id: z.string(),
		title: z.string(),
		description: z.string(),
		status: z.enum(['draft', 'active', 'archived', 'deleted']),
		author: z.string(),
		created_at: dt(),
		updated_at: dt(),
		last_run_at: z.string().nullable(),
		tags: z.array(z.string()),
		runtime: RuntimeResponseSchema.optional(),
	})
	.openapi('NotebookMeta');

export const LocalSourceResponseSchema = z.object({
	schema_version: z.literal(1),
	type: z.literal('local'),
	current_version_id: z.string(),
});

export const GithubSourceResponseSchema = z.object({
	schema_version: z.literal(1),
	type: z.literal('github'),
	repo: z.string(),
	branch: z.string(),
	path: z.string(),
	commit: z.string(),
	last_synced_at: dt(),
});

export const SourceResponseSchema = z
	.discriminatedUnion('type', [LocalSourceResponseSchema, GithubSourceResponseSchema])
	.openapi('Source');

export const NotebookDetailResponseSchema = z
	.object({
		meta: NotebookMetaResponseSchema,
		readme: z.string().nullable(),
		source: SourceResponseSchema,
	})
	.openapi('NotebookDetail');

export const VersionResponseSchema = z
	.object({
		schema_version: z.literal(1),
		version_id: z.string(),
		notebook_id: z.string(),
		saved_at: dt(),
		author: z.string(),
		message: z.string(),
		parent_id: z.string().nullable(),
	})
	.openapi('Version');

export const SessionResponseSchema = z
	.object({
		session_id: z.string(),
		notebook_id: z.string(),
		project_id: z.string(),
		status: z.enum(['starting', 'running', 'idle', 'terminated', 'expired']),
		sandbox_url: z.string().optional(),
		started_at: dt(),
		last_heartbeat: dt(),
	})
	.openapi('Session');

export const ExecResultResponseSchema = z
	.object({
		success: z.boolean(),
		stdout: z.string(),
		stderr: z.string(),
	})
	.openapi('ExecResult');
