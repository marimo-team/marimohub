import { createRoute, z } from '@hono/zod-openapi';
import type { NotebookId, ProjectId, SandboxId, SessionId } from '@marimo-hub/core';
import { createSandboxId, NotFoundError, ResourceExhaustedError } from '@marimo-hub/core';
import { SandboxProvisioner } from '@marimo-hub/core';
import {
	assertProjectRole,
	createApp,
	ErrorResponseSchema,
	jsonContent,
	NotebookIdParam,
	SessionIdParam,
	SessionResponseSchema,
	SuccessResponseSchema,
} from '../shared';

// --- Route definitions ---

const createSession = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sessions',
	tags: ['Sessions'],
	summary: 'Create a session and provision a sandbox',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SessionResponseSchema }),
			'Session created',
		),
		403: jsonContent(ErrorResponseSchema, 'Insufficient role'),
		404: jsonContent(ErrorResponseSchema, 'Notebook not found'),
		422: jsonContent(ErrorResponseSchema, 'Validation error'),
		429: jsonContent(ErrorResponseSchema, 'Concurrent session limit reached'),
	},
});

const deleteSession = createRoute({
	method: 'delete',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}',
	tags: ['Sessions'],
	summary: 'Terminate a session and destroy sandbox',
	request: { params: SessionIdParam },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Session terminated'),
		403: jsonContent(ErrorResponseSchema, 'Insufficient role'),
		404: jsonContent(ErrorResponseSchema, 'Session not found'),
	},
});

const heartbeatSession = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}/heartbeat',
	tags: ['Sessions'],
	summary: 'Update session heartbeat',
	request: { params: SessionIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SessionResponseSchema }),
			'Heartbeat updated',
		),
		403: jsonContent(ErrorResponseSchema, 'Insufficient role'),
		404: jsonContent(ErrorResponseSchema, 'Session not found'),
	},
});

// --- App ---

const app = createApp();

app.openapi(createSession, async (c) => {
	const { sessions, projects } = c.get('deps').services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');

	// Starting a session runs code — requires editor+ on the project.
	await assertProjectRole(projects, pid as ProjectId, user.id, 'editor');

	// Cost-DoS guard: cap a user's concurrent (billable) sessions. A runaway
	// client reconnecting in a loop would otherwise provision unbounded sandboxes.
	const maxSessions = c.get('deps').maxConcurrentSessionsPerUser;
	if (maxSessions && maxSessions > 0) {
		const active = await sessions.countActiveForUser(user.id);
		if (active >= maxSessions) {
			throw new ResourceExhaustedError(
				`Concurrent session limit reached (${maxSessions}). Terminate a session before starting another.`,
			);
		}
	}

	const sandboxId = createSandboxId();

	const session = await sessions.createSession({
		notebook_id: nid as NotebookId,
		project_id: pid as ProjectId,
		user_id: user.id,
		sandbox_id: sandboxId,
	});

	const { compute, bucket: bucketHandle, sandboxBucket, sandboxHostname } = c.get('deps');
	const provisioner = new SandboxProvisioner(compute);

	const hostname = sandboxHostname || new URL(c.req.url).hostname;

	let url: string, usedFallback: boolean;
	try {
		({ url, usedFallback } = await provisioner.provision({
			sandboxId,
			projectId: pid as ProjectId,
			notebookId: nid as NotebookId,
			hostname,
			bucket: sandboxBucket,
			bucketHandle,
		}));
	} catch (err) {
		// Provisioning failed: tear down any partial sandbox and mark the session
		// terminated so it does not linger in `starting` and so the reaper collects it.
		try {
			await compute.create(sandboxId).destroy();
		} catch {
			// Sandbox may not exist
		}
		try {
			await sessions.terminate(session.session_id);
		} catch {
			// Best-effort
		}
		throw err;
	}

	const updated = await sessions.setRunning(session.session_id, url, usedFallback);

	return c.json(
		{
			success: true,
			data: {
				session_id: updated.session_id,
				notebook_id: updated.notebook_id,
				project_id: updated.project_id,
				status: updated.status,
				sandbox_url: updated.sandbox_url,
				started_at: updated.started_at,
				last_heartbeat: updated.last_heartbeat,
			},
		},
		200,
	);
});

app.openapi(deleteSession, async (c) => {
	const { sessions, projects } = c.get('deps').services;
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');

	// Scope-check: a session that does not belong to this notebook/project is
	// reported as not-found so cross-scope existence is not leaked.
	const existing = await sessions.getSession(sid as SessionId);
	if (existing.project_id !== (pid as ProjectId) || existing.notebook_id !== (nid as NotebookId)) {
		throw new NotFoundError(`Session ${sid} not found`);
	}

	// Terminating a session tears down a running kernel — requires editor+.
	await assertProjectRole(projects, pid as ProjectId, user.id, 'editor');

	const session = await sessions.terminate(sid as SessionId);

	// Save files back and destroy sandbox
	if (session.sandbox_id) {
		try {
			const { compute, bucket: bucketHandle } = c.get('deps');
			const provisioner = new SandboxProvisioner(compute);
			const sandbox = compute.create(session.sandbox_id as SandboxId);

			await provisioner.teardown(
				sandbox,
				bucketHandle,
				session.project_id,
				session.notebook_id,
				session.used_fallback ?? false,
			);
		} catch {
			// Best-effort: sandbox may already be destroyed
		}
	}

	return c.json({ success: true }, 200);
});

app.openapi(heartbeatSession, async (c) => {
	const { sessions, projects } = c.get('deps').services;
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');

	// Scope-check: a session that does not belong to this notebook/project is
	// reported as not-found so cross-scope existence is not leaked.
	const existing = await sessions.getSession(sid as SessionId);
	if (existing.project_id !== (pid as ProjectId) || existing.notebook_id !== (nid as NotebookId)) {
		throw new NotFoundError(`Session ${sid} not found`);
	}

	// Extending a session keeps a kernel alive — requires editor+.
	await assertProjectRole(projects, pid as ProjectId, user.id, 'editor');

	const updated = await sessions.heartbeat(sid as SessionId);

	return c.json(
		{
			success: true,
			data: {
				session_id: updated.session_id,
				notebook_id: updated.notebook_id,
				project_id: updated.project_id,
				status: updated.status,
				sandbox_url: updated.sandbox_url,
				started_at: updated.started_at,
				last_heartbeat: updated.last_heartbeat,
			},
		},
		200,
	);
});

export default app;
