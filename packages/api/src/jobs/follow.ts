import { Hono } from 'hono';
import {
	bearerToken,
	DomainError,
	logOperationalError,
	NotFoundError,
	RunNotFollowableError,
	sleep as defaultSleep,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal, JobRun } from '@marimo-hub/core';
import {
	connectRunSandbox,
	isLiveRun,
	isTerminalRunStatus,
	readRunEvents,
	readRunFollowShell,
	RUN_FOLLOW_TOKEN_TTL_MS,
	signRunFollowToken,
	verifyRunFollowToken,
} from '@marimo-hub/core/jobs';
import type {
	LiveJobRun,
	RunFollowBatch,
	RunFollowEvent,
	RunFollowTokenClaims,
} from '@marimo-hub/core/jobs';
import { sseResponse } from '@marimo-hub/host-protocol';
import type { ApiDeps, HonoEnv } from '../context';
import { fail, resolvePublicBaseUrlFor } from '../shared';
import { loadReadableRun, requireJobs } from './operations';

export const RUN_FOLLOW_PATH = '/api/run-follow/v1';

/** Pause between event batches; the in-sandbox client already waits up to a second for events. */
const BATCH_PAUSE_MS = 250;
/** How often an open stream rechecks the follower's access and the run's status. */
const RECHECK_MS = 10_000;
/** How long a stream tolerates a host that is not serving while the run record says running. */
const HOST_GRACE_MS = 30_000;
/** Each stream costs the run's sandbox one process per batch. */
const MAX_STREAMS_PER_RUN = 8;

/**
 * The view a follower mounts for a run that is executing: the marimo frontend, bound to this
 * deployment's follow endpoint by a token for this user and run. Null when the run is not
 * executing under a marimo host, or its host is not serving yet.
 */
export async function runFollowView(
	deps: ApiDeps,
	user: AuthenticatedPrincipal,
	run: JobRun,
	request: Request,
): Promise<{ html: string; expires_at: string } | null> {
	const secret = requireJobs(deps).liveRuns?.signingSecret;
	if (!secret || !isLiveRun(run)) return null;
	const sandbox = connectRunSandbox(deps.compute, run);
	if (!sandbox) return null;
	const expiresAt = Math.min(
		Date.now() + RUN_FOLLOW_TOKEN_TTL_MS,
		Date.parse(run.deadline_at ?? '') || Number.POSITIVE_INFINITY,
		Date.parse(user.entitlementsExpiresAt ?? '') || Number.POSITIVE_INFINITY,
	);
	// A run past its deadline is about to be timed out; a view of it would expire on arrival.
	if (expiresAt <= Date.now()) return null;
	const token = await signRunFollowToken(
		{
			principal: user,
			projectId: run.project_id,
			notebookId: run.notebook_id,
			jobId: run.job_id,
			runId: run.run_id,
			expiresAt,
		},
		secret,
	);
	const html = await readRunFollowShell(sandbox, run, {
		url: `${resolvePublicBaseUrlFor(request, deps.sandbox.appBaseUrl)}${RUN_FOLLOW_PATH}`,
		token,
	});
	return html === undefined ? null : { html, expires_at: new Date(expiresAt).toISOString() };
}

/** The follower's live access to the run: the access that reading the run's output needs. */
async function authorizeFollower(deps: ApiDeps, claims: RunFollowTokenClaims): Promise<JobRun> {
	if (await deps.services.identities.isSuspended(claims.principal.id)) {
		throw new NotFoundError('Run not found');
	}
	const { run } = await loadReadableRun(
		deps,
		claims.principal,
		claims.projectId,
		claims.notebookId,
		claims.jobId,
		claims.runId,
	);
	return run;
}

/** One SSE frame, or undefined for an event that cannot be relayed safely. */
function frame(event: RunFollowEvent): string | undefined {
	let data = event.data;
	if (event.event === 'notebook') {
		// A follower can never operate the run, whatever its marimo host offers its own clients.
		// The host runs beside notebook code, so its output is not trusted to be well formed.
		try {
			const record = JSON.parse(data) as { notebook?: Record<string, unknown> } | null;
			if (!record || typeof record.notebook !== 'object' || record.notebook === null) return;
			record.notebook.operations = [];
			data = JSON.stringify(record);
		} catch {
			return;
		}
	}
	const field = (value: string) => value.replaceAll(/[\r\n]/g, '');
	const id = event.id ? `id: ${field(event.id)}\n` : '';
	const lines = data
		.split('\n')
		.map((line) => `data: ${line.replaceAll('\r', '')}`)
		.join('\n');
	return `${id}event: ${field(event.event)}\n${lines}\n\n`;
}

const streamsPerRun = new Map<string, number>();

/**
 * Relay a live run's notebook stream until the run ends, the follower loses access, the token
 * expires, or the client disconnects. Each batch is one command in the run's sandbox.
 */
function followStream(
	deps: ApiDeps,
	claims: RunFollowTokenClaims,
	first: LiveJobRun,
	request: Request,
): Response {
	const sleep = deps.sleep ?? defaultSleep;
	const currentRun = () =>
		deps.services.jobRuns.getRun(claims.projectId, claims.notebookId, claims.jobId, claims.runId);

	const relay = async (write: (frame: string) => Promise<void>, signal: AbortSignal) => {
		let run = first;
		let sandbox = connectRunSandbox(deps.compute, run);
		let cursor = request.headers.get('Last-Event-ID') || undefined;
		let checkedAt = Date.now();
		let goneSince: number | undefined;
		while (sandbox && !signal.aborted && Date.now() < claims.expiresAt) {
			if (Date.now() - checkedAt >= RECHECK_MS) {
				const current = await authorizeFollower(deps, claims);
				if (!isLiveRun(current)) return;
				run = current;
				sandbox = connectRunSandbox(deps.compute, run);
				checkedAt = Date.now();
				continue;
			}
			let batch: RunFollowBatch;
			try {
				batch = await readRunEvents(sandbox, run, cursor, signal);
			} catch (error) {
				// A finished run's sandbox is destroyed; a failed read then is the normal end.
				if (isLiveRun(await currentRun())) throw error;
				return;
			}
			if ('gone' in batch) {
				goneSince ??= Date.now();
				if (Date.now() - goneSince >= HOST_GRACE_MS) return;
				// The host exits moments before the run record turns terminal.
				if (isTerminalRunStatus((await currentRun()).status)) return;
				await sleep(1_000, signal);
				continue;
			}
			goneSince = undefined;
			for (const event of batch.events) {
				const text = frame(event);
				if (text !== undefined) await write(text);
				if (event.id) cursor = event.id;
			}
			await sleep(BATCH_PAUSE_MS, signal);
		}
	};

	const key = claims.runId;
	streamsPerRun.set(key, (streamsPerRun.get(key) ?? 0) + 1);
	return sseResponse(request, async (write, signal) => {
		try {
			await relay(write, signal);
		} catch (error) {
			if (!signal.aborted && !(error instanceof DomainError)) {
				logOperationalError(
					'run_follow_stream_failed',
					{ operation: 'job.run.follow', run_id: key },
					error,
				);
			}
		} finally {
			const open = (streamsPerRun.get(key) ?? 1) - 1;
			if (open > 0) streamsPerRun.set(key, open);
			else streamsPerRun.delete(key);
		}
	});
}

/**
 * The endpoint the follow view's marimo frontend treats as its runtime. It serves a liveness
 * probe and the run's read-only event stream; every other marimo route is unsupported.
 *
 * Callers are frames with an opaque origin, so there are no cookies: the bearer token alone
 * identifies the user and run, and CORS is open because the token is the authority.
 */
export function createRunFollowApp(deps: ApiDeps) {
	const app = new Hono<HonoEnv>();

	app.use('*', async (c, next) => {
		c.header('Access-Control-Allow-Origin', '*');
		c.header('Cache-Control', 'no-store');
		if (c.req.method === 'OPTIONS') {
			c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
			// `*` does not cover Authorization, so echo what the frontend asks to send.
			c.header(
				'Access-Control-Allow-Headers',
				c.req.header('Access-Control-Request-Headers') ?? 'authorization',
			);
			c.header('Access-Control-Max-Age', '600');
			return c.body(null, 204);
		}
		await next();
	});

	// The frontend probes this without credentials before it opens the stream.
	app.get('/health', (c) => c.json({ status: 'healthy' }));

	app.get('/sse', async (c) => {
		const secret = deps.jobs?.liveRuns?.signingSecret;
		const token = bearerToken(c.req.raw);
		const claims = secret && token ? await verifyRunFollowToken(token, secret) : null;
		if (!claims) return fail(c, 'UNAUTHORIZED', 'Follow token expired or invalid', 401);
		const run = await authorizeFollower(deps, claims);
		if (!isLiveRun(run) || !connectRunSandbox(deps.compute, run)) throw new RunNotFollowableError();
		if ((streamsPerRun.get(claims.runId) ?? 0) >= MAX_STREAMS_PER_RUN) {
			return fail(c, 'RESOURCE_EXHAUSTED', 'Too many followers of this run', 429);
		}
		const response = followStream(deps, claims, run, c.req.raw);
		response.headers.set('Access-Control-Allow-Origin', '*');
		return response;
	});

	app.all('*', (c) =>
		c.body(
			JSON.stringify({
				type: 'urn:marimo:problem:unsupported-operation',
				title: 'Unsupported operation',
				status: 501,
				detail: 'A followed run is read-only',
			}),
			501,
			{ 'Content-Type': 'application/problem+json' },
		),
	);

	return app;
}
