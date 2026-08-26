import { createRoute, z } from '@hono/zod-openapi';
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
	createProjectId,
	createServices,
	ForbiddenError,
	NotFoundError,
	paths,
} from '@marimo-hub/core';
import { MemoryBucket, makeProject, uid } from '@marimo-hub/core/testing';
import {
	assertProjectRole,
	assertSessionAccess,
	assertSessionControl,
	createApp,
	ErrorResponseSchema,
	extensibleResponseEnum,
	jsonBody,
	jsonContent,
	NotebookIdParam,
	ProjectIdParam,
	resolvePublicBaseUrl,
	SessionIdParam,
} from './shared';

describe('resolvePublicBaseUrl', () => {
	it('uses the public host and forwarded protocol behind a reverse proxy', async () => {
		const app = createApp();
		app.get('/base', (c) => c.text(resolvePublicBaseUrl(c)));

		const response = await app.request('http://api.internal/base', {
			headers: { host: 'hub.example.com', 'x-forwarded-proto': 'https, http' },
		});

		expect(await response.text()).toBe('https://hub.example.com');
	});

	it.each([
		['https://hub.example.com', 'https://hub.example.com'],
		['https://hub.example.com/', 'https://hub.example.com'],
		['https://hub.example.com/base', 'https://hub.example.com/base'],
		['https://hub.example.com/base/', 'https://hub.example.com/base'],
		['https://hub.example.com/base///?ignored=1#ignored', 'https://hub.example.com/base'],
	] as const)('normalizes configured public URL %s', async (configured, expected) => {
		const app = createApp();
		app.get('/base', (c) => c.text(resolvePublicBaseUrl(c, configured)));

		expect(await (await app.request('http://api.internal/base')).text()).toBe(expected);
	});
});

describe('extensibleResponseEnum', () => {
	const schema = z.object({
		root_kind: extensibleResponseEnum(['bucket', 'container'], 'bucket'),
	});

	it('preserves known literals and normalizes future values', () => {
		expect(schema.parse({ root_kind: 'bucket' })).toEqual({ root_kind: 'bucket' });
		expect(schema.parse({ root_kind: 'future-root' })).toEqual({ root_kind: 'unknown' });
		expect(schema.safeParse({}).success).toBe(false);
		expect(schema.safeParse({ root_kind: 1 }).success).toBe(false);
	});

	it('exposes a closed output union with an unknown fallback', () => {
		const parsed = schema.parse({ root_kind: 'container' });
		expectTypeOf(parsed.root_kind).toEqualTypeOf<'bucket' | 'container' | 'unknown'>();
	});
});

// Seed a project's meta object directly so we can pin arbitrary members/roles
// without going through the catalog/snapshot machinery.
async function seedProject(
	bucket: MemoryBucket,
	overrides: Parameters<typeof makeProject>[0] = {},
) {
	const project = makeProject(overrides);
	await bucket.put(paths.project(project.id).meta, JSON.stringify(project));
	return project;
}

describe('assertProjectRole', () => {
	it('passes when the owner (implicit admin) meets the requirement', async () => {
		const bucket = new MemoryBucket();
		const { id } = await seedProject(bucket, { owner: uid('owner-1'), members: [] });
		const { projects } = createServices(bucket);

		// Returns the loaded project (callers reuse it without a second fetch).
		await expect(
			assertProjectRole(
				projects,
				id,
				{ id: uid('owner-1'), email: 'owner-1@example.com' },
				'admin',
			),
		).resolves.toMatchObject({
			id,
		});
	});

	it('passes when a member exceeds the minimum role (editor satisfies viewer)', async () => {
		const bucket = new MemoryBucket();
		const { id } = await seedProject(bucket, {
			owner: uid('someone-else'),
			members: [{ user_id: uid('editor-1'), role: 'editor' }],
		});
		const { projects } = createServices(bucket);

		await expect(
			assertProjectRole(
				projects,
				id,
				{ id: uid('editor-1'), email: 'editor-1@example.com' },
				'viewer',
			),
		).resolves.toMatchObject({ id });
	});

	it('passes when a manager meets the project-management requirement', async () => {
		const bucket = new MemoryBucket();
		const { id } = await seedProject(bucket, {
			owner: uid('someone-else'),
			members: [{ user_id: uid('manager-1'), role: 'manager' }],
		});
		const { projects } = createServices(bucket);

		await expect(
			assertProjectRole(
				projects,
				id,
				{ id: uid('manager-1'), email: 'manager-1@example.com' },
				'manager',
			),
		).resolves.toMatchObject({ id });
	});

	it('throws ForbiddenError when the member role is insufficient (viewer < editor)', async () => {
		const bucket = new MemoryBucket();
		const { id } = await seedProject(bucket, {
			owner: uid('someone-else'),
			members: [{ user_id: uid('viewer-1'), role: 'viewer' }],
		});
		const { projects } = createServices(bucket);

		await expect(
			assertProjectRole(
				projects,
				id,
				{ id: uid('viewer-1'), email: 'viewer-1@example.com' },
				'editor',
			),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('throws ForbiddenError for a non-member', async () => {
		const bucket = new MemoryBucket();
		const { id } = await seedProject(bucket, { owner: uid('someone-else'), members: [] });
		const { projects } = createServices(bucket);

		await expect(
			assertProjectRole(
				projects,
				id,
				{ id: uid('stranger'), email: 'stranger@example.com' },
				'viewer',
			),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('throws NotFoundError when the project does not exist', async () => {
		const bucket = new MemoryBucket();
		const { projects } = createServices(bucket);

		await expect(
			assertProjectRole(
				projects,
				createProjectId(),
				{ id: uid('anyone'), email: 'anyone@example.com' },
				'viewer',
			),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it('admits a non-member super admin at admin level', async () => {
		const bucket = new MemoryBucket();
		const { id } = await seedProject(bucket, { owner: uid('someone-else'), members: [] });
		const { projects } = createServices(bucket);

		await expect(
			assertProjectRole(projects, id, { id: uid('god'), email: 'god@example.com' }, 'admin', {
				superAdmins: ['god@example.com'],
			}),
		).resolves.toMatchObject({ id });
	});
});

describe('session authorization assertions', () => {
	const owner = uid('session-owner');
	const editor = uid('other-editor');
	const manager = uid('other-manager');
	const admin = uid('other-admin');
	const project = makeProject({
		owner,
		members: [
			{ user_id: editor, role: 'editor' },
			{ user_id: manager, role: 'manager' },
			{ user_id: admin, role: 'admin' },
		],
	});
	const session = {
		mode: 'edit' as const,
		ephemeral: false,
		user_id: owner,
		editor_sandbox_sharing: 'exclusive' as const,
	};

	it('denies a non-owner editor instead of falling back to project role', () => {
		const subject = { id: editor, email: 'editor@example.com' };
		expect(() => assertSessionAccess(project, session, subject, {})).toThrow(ForbiddenError);
		expect(() => assertSessionControl(project, session, subject, {})).toThrow(ForbiddenError);
	});

	it('denies admin attach while preserving force-stop authority', () => {
		const subject = { id: admin, email: 'admin@example.com' };
		expect(() => assertSessionAccess(project, session, subject, {})).toThrow(ForbiddenError);
		expect(() => assertSessionControl(project, session, subject, {})).not.toThrow();
	});

	it('denies manager attach while preserving force-stop authority', () => {
		const subject = { id: manager, email: 'manager@example.com' };
		expect(() => assertSessionAccess(project, session, subject, {})).toThrow(ForbiddenError);
		expect(() => assertSessionControl(project, session, subject, {})).not.toThrow();
	});
});

describe('path param schemas', () => {
	const VALID_PID = 'proj-7h2k9qm4xz7rp3w8';
	const VALID_NID = 'nb-3w8h2k9qm4xz7rp3';
	const VALID_SID = 'sess-9qm4xz7rp3w8h2k9';

	it('ProjectIdParam accepts a valid pid and rejects a malformed one', () => {
		expect(ProjectIdParam.safeParse({ pid: VALID_PID }).success).toBe(true);
		expect(ProjectIdParam.safeParse({ pid: 'nb-7h2k9qm4xz7rp3w8' }).success).toBe(false);
		expect(ProjectIdParam.safeParse({ pid: 'proj-TOOSHORT' }).success).toBe(false);
	});

	it('NotebookIdParam requires BOTH a valid pid and nid', () => {
		expect(NotebookIdParam.safeParse({ pid: VALID_PID, nid: VALID_NID }).success).toBe(true);
		expect(NotebookIdParam.safeParse({ pid: VALID_PID }).success).toBe(false);
		expect(NotebookIdParam.safeParse({ pid: 'bad', nid: VALID_NID }).success).toBe(false);
	});

	it('SessionIdParam requires pid, nid AND sid', () => {
		expect(
			SessionIdParam.safeParse({ pid: VALID_PID, nid: VALID_NID, sid: VALID_SID }).success,
		).toBe(true);
		expect(
			SessionIdParam.safeParse({ pid: VALID_PID, nid: VALID_NID, sid: 'sess-bad' }).success,
		).toBe(false);
	});
});

describe('createApp defaultHook', () => {
	// A throwaway app mounting one route whose body must validate, so we can drive
	// the shared defaultHook directly rather than through a full domain route.
	function appWithEchoRoute() {
		const app = createApp();
		const Body = z.object({ n: z.number(), label: z.string().min(1) });
		const route = createRoute({
			method: 'post',
			path: '/echo',
			request: { body: jsonBody(Body) },
			responses: {
				200: jsonContent(Body, 'ok'),
				422: jsonContent(ErrorResponseSchema, 'Validation error'),
			},
		});
		// Minimal handler; only the valid path is exercised here.
		app.openapi(route, (c) => c.json(c.req.valid('json'), 200));
		return app;
	}

	it('passes a valid body through to the handler (no hook interception)', async () => {
		const res = await appWithEchoRoute().request('/echo', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ n: 1, label: 'ok' }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ n: 1, label: 'ok' });
	});

	it('rejects an invalid body with a 422 VALIDATION_ERROR envelope', async () => {
		const res = await appWithEchoRoute().request('/echo', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ label: '' }), // n missing, label empty
		});

		expect(res.status).toBe(422);
		const body = (await res.json()) as {
			success: boolean;
			error: {
				code: string;
				message: string;
				details: { field: string; message: string }[];
			};
		};
		expect(body.success).toBe(false);
		expect(body.error.code).toBe('VALIDATION_ERROR');
		expect(body.error.message).toContain('n:');
		expect(body.error.message).toContain('label:');
		expect(body.error.details).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ field: 'n' }),
				expect.objectContaining({ field: 'label' }),
			]),
		);
	});
});
