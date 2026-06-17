import { createRoute, z } from '@hono/zod-openapi';
import { describe, it, expect } from 'vitest';
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
	createApp,
	ErrorResponseSchema,
	jsonBody,
	jsonContent,
	NotebookIdParam,
	ProjectIdParam,
	SessionIdParam,
} from './shared';

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
		await expect(assertProjectRole(projects, id, uid('owner-1'), 'admin')).resolves.toMatchObject({
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

		await expect(assertProjectRole(projects, id, uid('editor-1'), 'viewer')).resolves.toMatchObject(
			{ id },
		);
	});

	it('throws ForbiddenError when the member role is insufficient (viewer < editor)', async () => {
		const bucket = new MemoryBucket();
		const { id } = await seedProject(bucket, {
			owner: uid('someone-else'),
			members: [{ user_id: uid('viewer-1'), role: 'viewer' }],
		});
		const { projects } = createServices(bucket);

		await expect(assertProjectRole(projects, id, uid('viewer-1'), 'editor')).rejects.toBeInstanceOf(
			ForbiddenError,
		);
	});

	it('throws ForbiddenError for a non-member', async () => {
		const bucket = new MemoryBucket();
		const { id } = await seedProject(bucket, { owner: uid('someone-else'), members: [] });
		const { projects } = createServices(bucket);

		await expect(assertProjectRole(projects, id, uid('stranger'), 'viewer')).rejects.toBeInstanceOf(
			ForbiddenError,
		);
	});

	it('throws NotFoundError when the project does not exist', async () => {
		const bucket = new MemoryBucket();
		const { projects } = createServices(bucket);

		await expect(
			assertProjectRole(projects, createProjectId(), uid('anyone'), 'viewer'),
		).rejects.toBeInstanceOf(NotFoundError);
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
			error: { code: string; message: string };
		};
		expect(body.success).toBe(false);
		expect(body.error.code).toBe('VALIDATION_ERROR');
		// The hook flattens every zod issue into one "path: message" string.
		expect(typeof body.error.message).toBe('string');
		expect(body.error.message.length).toBeGreaterThan(0);
	});
});
