import { createRoute, z } from '@hono/zod-openapi';
import type { ProvisionOptions, Session } from '@marimo-hub/core';
import {
	aiConfigToSessionEnv,
	BadRequestError,
	createSandboxId,
	DomainError,
	effectiveRole,
	exchangeFederatedStorageEnv,
	mintAiSessionToken,
	NotFoundError,
	paths,
	requireRole,
	resolveRestoreSnapshot,
	ResourceExhaustedError,
	saga,
	SandboxProvisioner,
	SubdomainExposure,
	workspaceSourcePolicy,
} from '@marimo-hub/core';
import { logObserver } from '../saga';
import {
	assertProjectVisible,
	assertSessionControl,
	commonErrors,
	createApp,
	errorResponses,
	IdempotencyKeyHeader,
	jsonContent,
	NotebookIdParam,
	ProjectIdParam,
	SessionIdParam,
	SessionResponseSchema,
	SuccessResponseSchema,
} from '../shared';
import { pageSchema, paginate, PaginationQuery } from '../pagination';

/**
 * Compose two sessionEnv producers (e.g. WIF + managed AI): concat `files`,
 * spread-merge `vars`. Either side may be undefined.
 */
function mergeSessionEnv(
	base: ProvisionOptions['sessionEnv'],
	add: { files: { path: string; content: string }[]; vars: Record<string, string> },
): ProvisionOptions['sessionEnv'] {
	return {
		files: [...(base?.files ?? []), ...add.files],
		vars: { ...base?.vars, ...add.vars },
	};
}

// --- Route definitions ---

// createSession is create-or-reuse; `reused` lets the client tell a reconnect
// (the caller's existing session is returned) from a freshly provisioned one.
const SessionCreateResponseSchema = SessionResponseSchema.extend({
	reused: z.boolean(),
}).openapi('SessionCreateResult');

const listSessions = createRoute({
	method: 'get',
	path: '/projects/{pid}/sessions',
	tags: ['Sessions'],
	summary: 'List active sessions for a project',
	request: { params: ProjectIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(SessionResponseSchema, 'SessionPage'),
			}),
			'Active sessions for the project, newest first',
		),
		...commonErrors(),
		...errorResponses(400),
	},
});

const createSession = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sessions',
	tags: ['Sessions'],
	summary: 'Create a session and provision a sandbox',
	// `Idempotency-Key` is accepted and documented, but this route is already
	// idempotent on (user, notebook) via the reuse path in the handler, so the key
	// needs no separate store: a retry hits the same reused session.
	description:
		'Create-or-reuse: returns the caller’s existing starting/running session for ' +
		'this notebook when one exists, otherwise provisions a new sandbox.',
	request: { params: NotebookIdParam, headers: IdempotencyKeyHeader },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SessionCreateResponseSchema }),
			'Session created or reused',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 429),
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
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const getSession = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}',
	tags: ['Sessions'],
	summary: 'Get a session (status + kernel URL)',
	request: { params: SessionIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SessionResponseSchema }),
			'Session',
		),
		...commonErrors(),
		...errorResponses(404),
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
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

// --- App ---

/**
 * Project a stored Session onto the public Session response envelope. Exposes
 * `user_id` (who started it) for the collaborative "started by" UI — visible only
 * to users who can already list the project's sessions. Internal infra fields
 * (`sandbox_id`, `used_fallback`) stay private.
 */
function toSessionResponse(s: Session) {
	return {
		session_id: s.session_id,
		notebook_id: s.notebook_id,
		project_id: s.project_id,
		user_id: s.user_id,
		status: s.status,
		sandbox_url: s.sandbox_url,
		started_at: s.started_at,
		last_heartbeat: s.last_heartbeat,
		ephemeral: s.ephemeral,
		error: s.error,
	};
}

/**
 * Sanitize a provisioning error into the `{ code, message }` persisted on a failed
 * session. A DomainError contributes its own code/message; anything else becomes a
 * generic `PROVISION_FAILED` with only the error name + message — never raw upstream
 * detail or secret material (WIF/AI failures are already scrubbed and non-fatal).
 */
function toSessionError(err: unknown): { code: string; message: string } {
	if (err instanceof DomainError) return { code: err.code, message: err.message };
	const e = err instanceof Error ? err : new Error(String(err));
	return { code: 'PROVISION_FAILED', message: `${e.name}: ${e.message}` };
}

const app = createApp();

app.openapi(listSessions, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	// Read-only project-scoped data, gated at `viewer` like the notebook-list route:
	// open when a default role is set, members-only under MARIMOHUB_DEFAULT_ROLE=none.
	await assertProjectVisible(projects, pid, user.id, deps.policy.defaultRole);
	const active = await sessions.listActiveByProject(pid);
	const data = paginate(active.map(toSessionResponse), c.req.valid('query'), {
		key: (s) => s.started_at,
		tiebreak: (s) => s.session_id,
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(getSession, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');
	// Read-only, project-scoped (matches listSessions). The project-scoped key 404s
	// a cross-project id; the notebook check keeps a same-project/other-notebook id
	// out of scope.
	await assertProjectVisible(projects, pid, user.id, deps.policy.defaultRole);
	const session = await sessions.getSession(pid, sid);
	if (session.notebook_id !== nid) {
		throw new NotFoundError(`Session ${sid} not found`);
	}
	return c.json({ success: true, data: toSessionResponse(session) }, 200);
});

app.openapi(createSession, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects, notebooks } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');

	// Starting a session runs code — editor+ gets a normal (persisting) session.
	// An effective viewer is admitted only under MARIMOHUB_VIEWER_MODE=
	// ephemeral-sandbox, with a session whose edits are never written back; in
	// `static` mode viewers never reach a kernel. The loaded project is reused
	// below (federation opt-in) instead of re-fetched.
	const project = await projects.getProject(pid);
	const role = effectiveRole(project, user.id, deps.policy.defaultRole);
	const ephemeral = role !== 'editor' && role !== 'admin';
	if (ephemeral && !(role === 'viewer' && deps.policy.viewerMode === 'ephemeral-sandbox')) {
		// Throws the canonical editor-gate 403 (role is below editor here).
		requireRole(project, user.id, 'editor', deps.policy.defaultRole);
	}

	// Verify the notebook exists in this project — throws NotFoundError (→ 404)
	// otherwise. Prevents provisioning a billable sandbox for a bogus notebook id.
	const notebook = await notebooks.getNotebook(pid, nid);
	const workspacePolicy = workspaceSourcePolicy(notebook.source);
	// Synced sources are read-only mirrors served from the immutable workspace of the
	// version the source currently points at; a session can't start before a push.
	const syncedVersionId = workspacePolicy.persistSessionEdits
		? undefined
		: notebook.source.current_version_id;
	if (!workspacePolicy.persistSessionEdits && !syncedVersionId) {
		throw new BadRequestError('Synced notebook has not been synced yet');
	}
	const workspacePrefix = syncedVersionId
		? paths.project(pid).notebook(nid).version(syncedVersionId).workspacePrefix
		: undefined;

	const { compute, bucket: bucketHandle, sandbox } = deps;
	const provisioner = new SandboxProvisioner(compute);

	// Reuse: if the user already has a session for this notebook — a `running` one to
	// reconnect to, OR an in-flight `starting` one (a concurrent refresh is already
	// provisioning) — return it instead of provisioning a second sandbox. This is
	// what stops a refresh loop from piling up `starting` records and tripping the
	// cap. Checked before the cap (so a reuse is never rejected) and short-circuits
	// before any compute call. A `starting` reuse has no URL yet; the client polls
	// `GET …/sessions/{sid}` until it is `running`.
	const reusable = await sessions.findReusable(pid, nid, user.id);
	if (reusable) {
		// A role change flips the session class the caller is entitled to (a demoted
		// editor must not keep a persisting, WIF-holding kernel; a promoted viewer's
		// edits must stop being discarded). A stale-class session is retired below
		// like a dead kernel instead of reused.
		const classMismatch = !!reusable.ephemeral !== ephemeral;
		// Only a `running` reconnect can hit a dead kernel; a `starting` reuse has no
		// kernel yet. Probe what the browser would hit (origin in proxy mode, else url).
		const kernelUrl =
			reusable.status === 'running' && reusable.sandbox_id
				? (reusable.sandbox_origin_url ?? reusable.sandbox_url)
				: undefined;
		const dead =
			!!kernelUrl && !!deps.kernelProbe && (await deps.kernelProbe(kernelUrl)) === 'dead';
		if (!dead && !classMismatch) {
			return c.json({ success: true, data: { ...toSessionResponse(reusable), reused: true } }, 200);
		}

		// Sandbox alive but marimo exited (e.g. shut down from the notebook UI), so a
		// reconnect would 502. Retire it the way an explicit stop does — teardown reads
		// the notebook back from the still-live container and cuts a version the fresh
		// sandbox restores — then fall through to provision a new one. Best-effort, so a
		// concurrent refresh that also saw `dead` does no harm.
		const claimed = await sessions.beginTerminating(reusable.project_id, reusable.session_id);
		if (claimed.status === 'terminating' && reusable.sandbox_id) {
			try {
				await provisioner.teardown(
					compute.create(reusable.sandbox_id),
					notebooks,
					bucketHandle,
					pid,
					nid,
					reusable.user_id,
					sandbox.persistWorkspace,
					sandbox.workdir,
					{ persistEdits: !reusable.ephemeral },
				);
			} catch {
				// Sandbox may already be gone; still mark it terminated.
			}
		}
		await sessions.markTerminated(reusable.project_id, reusable.session_id);
	}

	// Cost-DoS guard: cap a user's concurrent (billable) sessions. A runaway
	// client reconnecting in a loop would otherwise provision unbounded sandboxes.
	const maxSessions = deps.policy.maxConcurrentSessionsPerUser;
	if (maxSessions && maxSessions > 0) {
		const active = await sessions.countActiveForUser(user.id);
		if (active >= maxSessions) {
			throw new ResourceExhaustedError(
				`Concurrent session limit reached (${maxSessions}). Terminate a session before starting another.`,
			);
		}
	}

	const sandboxId = createSandboxId();

	// createApi defaults this; the fallback satisfies the type for direct callers.
	const sandboxExposure = sandbox.exposure ?? new SubdomainExposure();
	const restoreFilesystemSnapshotId = workspacePolicy.restoreFilesystemSnapshot
		? await resolveRestoreSnapshot(compute, notebooks, pid, nid)
		: undefined;

	const hostname = sandbox.hostname || new URL(c.req.url).hostname;
	// App origin for building proxy-mode client URLs; falls back to this request.
	const appBaseUrl = sandbox.appBaseUrl ?? new URL(c.req.url).origin;

	// Provision as a saga: if a later step fails, completed steps compensate in
	// reverse — the session record is terminated (so it does not linger in
	// `starting` and the reaper collects it) and a provisioned sandbox is
	// destroyed. A failure *inside* provisioning self-cleans (see
	// SandboxProvisioner.provision); the saga handles failures after it.
	let session: Session | undefined;
	let updated: Session | undefined;
	let url = '';
	let usedFallback = false;
	// In subdomain mode clientUrl === url and originUrl is unset.
	let clientUrl = '';
	let originUrl: string | undefined;
	const observer = logObserver({
		event: 'session_provision',
		sandbox_id: sandboxId,
		project_id: pid,
		notebook_id: nid,
		user_id: user.id,
	});
	try {
		await saga(observer)
			.step('session_record', async () => {
				session = await sessions.createSession({
					notebook_id: nid,
					project_id: pid,
					user_id: user.id,
					sandbox_id: sandboxId,
					ephemeral,
				});
			})
			.step('sandbox_provision', {
				do: async () => {
					// `prepare` picks marimo's `--base-url`; `finalize` maps the adapter's
					// exposed URL to the client URL + the origin to persist.
					const exposureCtx = {
						sessionId: session!.session_id,
						projectId: pid,
						notebookId: nid,
						sandboxId,
						appBaseUrl,
					};
					const { baseUrl } = await sandboxExposure.prepare(exposureCtx);

					// Workload Identity Federation: if WIF is configured AND this project
					// opted in, mint a project-scoped JWT, exchange it for temporary S3 creds,
					// and inject them. Best-effort — a federation/policy gap yields no creds,
					// never a failed kernel. jwt/creds are never logged. Never injected into
					// an ephemeral (viewer) sandbox: a viewer must not receive the project's
					// federated storage credentials.
					let sessionEnv: ProvisionOptions['sessionEnv'];
					if (deps.wif && project.federation?.enabled && !ephemeral) {
						try {
							sessionEnv = {
								vars: await exchangeFederatedStorageEnv(
									deps.wif.issuer,
									deps.wif.issuerUrl,
									deps.wif.target,
									pid,
									session!.session_id,
								),
							};
						} catch (err) {
							// Non-fatal; record why (sanitized — broker errors carry no secret,
							// mint errors are crypto-only).
							observer.tag('wif_exchange_failed', true);
							observer.tag(
								'wif_exchange_error',
								err instanceof Error ? `${err.name}: ${err.message}` : String(err),
							);
						}
					}

					// Managed AI: mint a session-scoped token and inject the marimo AI config
					// pointed at our proxy. Best-effort — a mint failure yields no AI config,
					// never a failed kernel. The token is never logged.
					if (deps.ai) {
						try {
							const token = await mintAiSessionToken(
								deps.ai.signingSecret,
								{
									projectId: pid,
									notebookId: nid,
									sessionId: session!.session_id,
									userId: user.id,
								},
								{ ttlSeconds: deps.ai.tokenTtlSeconds },
							);
							const aiEnv = aiConfigToSessionEnv(
								{
									baseUrl: `${appBaseUrl}/api/ai/v1`,
									apiKey: token,
									model: deps.ai.model,
									enabled: true,
									maxTokens: deps.ai.maxTokens,
									rules: deps.ai.rules,
								},
								deps.ai.xdgPath,
							);
							sessionEnv = mergeSessionEnv(sessionEnv, aiEnv);
						} catch (err) {
							observer.tag('ai_inject_failed', true);
							observer.tag(
								'ai_inject_error',
								err instanceof Error ? `${err.name}: ${err.message}` : String(err),
							);
						}
					}

					const provisionResult = await provisioner.provision({
						sandboxId,
						projectId: pid,
						notebookId: nid,
						hostname,
						bucket: sandbox.bucket,
						bucketHandle,
						workdir: sandbox.workdir,
						assetUrl: sandbox.assetUrl,
						baseUrl,
						restoreFilesystemSnapshotId,
						sessionEnv,
						entryNotebook: workspacePolicy.entryNotebook,
						// Ephemeral sandboxes never mount the live workspace: a mount writes
						// viewer edits straight through to the bucket (bypassing every
						// persistEdits guard) and puts the deployment's bucket credentials
						// inside a viewer's sandbox. Copy-only loads the files server-side.
						workspaceLoadMode: ephemeral ? 'copy-only' : workspacePolicy.loadMode,
						workspacePrefix,
					});
					({ url, usedFallback } = provisionResult);
					// Per-phase durations onto the session_provision event.
					for (const [phase, ms] of Object.entries(provisionResult.timings)) {
						observer.tag(`provision_${phase}_ms`, ms);
					}
					// Whether the files phase mounted the bucket (false) or copied it in
					// (true) — files is the largest phase, so this says which path to optimize.
					observer.tag('provision_used_fallback', usedFallback);
					({ clientUrl, originUrl } = await sandboxExposure.finalize(url, exposureCtx));
				},
				compensate: () => compute.create(sandboxId).destroy(),
			})
			.step('mark_running', async () => {
				// The lifetime clock starts here — when the kernel is live, not at record
				// creation — so provisioning time never eats into the session TTL.
				const ttlMs = sandbox.sessionLifetime?.maxLifetimeMs;
				updated = await sessions.setRunning(
					pid,
					session!.session_id,
					clientUrl,
					usedFallback,
					originUrl,
					ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined,
				);
			})
			.run();
	} catch (err) {
		// Record WHY the session failed so the client polling `GET …/sessions/{sid}`
		// sees a reason, not a bare `failed`. Best-effort (never mask the original
		// error): a marking failure just leaves the record for the stale reaper, and
		// markFailed no-ops if a concurrent stop already made it terminal.
		if (session) {
			await sessions.markFailed(pid, session.session_id, toSessionError(err)).catch(() => {});
		}
		throw err;
	} finally {
		observer.flush();
	}

	return c.json({ success: true, data: { ...toSessionResponse(updated!), reused: false } }, 200);
});

app.openapi(deleteSession, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects, notebooks } = deps.services;
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');

	// Scope-check: the project-scoped key 404s a cross-project id; the notebook
	// check keeps a same-project/other-notebook id out of scope.
	const existing = await sessions.getSession(pid, sid);
	if (existing.notebook_id !== nid) {
		throw new NotFoundError(`Session ${sid} not found`);
	}

	// Terminating a session tears down a running kernel — editor+, or the owner of
	// their own ephemeral session (role re-checked; see assertSessionControl).
	await assertSessionControl(projects, existing, user.id, deps.policy.defaultRole);

	// Mark `terminating` first (atomic): pollers immediately see `Stopping…` while
	// the teardown below runs, instead of a stale `running`. The CAS in the service
	// makes this stick even against an in-flight heartbeat.
	const session = await sessions.beginTerminating(pid, sid);

	// Read the notebook back, cut a version of the session's edits (with any
	// HTML/session snapshots), then destroy the sandbox. Attribute the version to
	// the session's owner (who made the edits), not whoever triggered the close.
	if (session.sandbox_id) {
		try {
			const { compute, bucket } = deps;
			const provisioner = new SandboxProvisioner(compute);
			const sandbox = compute.create(session.sandbox_id);

			await provisioner.teardown(
				sandbox,
				notebooks,
				bucket,
				session.project_id,
				session.notebook_id,
				session.user_id,
				deps.sandbox.persistWorkspace,
				deps.sandbox.workdir,
				{ persistEdits: !session.ephemeral },
			);
		} catch {
			// Best-effort: sandbox may already be destroyed
		}
	}

	// Teardown done (or the sandbox was already gone) → terminal.
	await sessions.markTerminated(pid, sid);

	return c.json({ success: true }, 200);
});

app.openapi(heartbeatSession, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');

	// Scope-check: the project-scoped key 404s a cross-project id; the notebook
	// check keeps a same-project/other-notebook id out of scope.
	const existing = await sessions.getSession(pid, sid);
	if (existing.notebook_id !== nid) {
		throw new NotFoundError(`Session ${sid} not found`);
	}

	// Extending a session keeps a kernel alive — editor+, or the owner of their
	// own ephemeral session (role re-checked; see assertSessionControl).
	await assertSessionControl(projects, existing, user.id, deps.policy.defaultRole);

	const updated = await sessions.heartbeat(pid, sid);

	return c.json({ success: true, data: toSessionResponse(updated) }, 200);
});

export default app;
