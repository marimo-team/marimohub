import { z } from 'zod';
import { withDeadline } from '../../async';
import { UnavailableError } from '../../errors';
import type { JobId, NotebookId, ProjectId, RunId } from '../../ids';
import { fromBase64Url, toBase64Url } from '../../internal/base64url';
import type { AuthenticatedPrincipal } from '../../ports/auth';
import type { SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { JobRun } from '../../schema';
import { shellQuote } from '../runtime/shell';
import { JOB_OUTPUT_FILE } from './JobRunner';
import {
	FOLLOW_SHELL_FILE,
	FOLLOW_TOKEN_PLACEHOLDER,
	FOLLOW_URL_PLACEHOLDER,
	HOST_CLIENT_PYTHON,
	HOST_DESCRIPTOR_FILE,
} from './liveRunHost';

/** The runner keeps its host files beside the run's output. */
const HOST_FILES_DIRECTORY = JOB_OUTPUT_FILE.slice(0, JOB_OUTPUT_FILE.lastIndexOf('/'));
const MAX_SHELL_BYTES = 8 * 1024 * 1024;
/** The in-sandbox client's batch limit, with room for JSON escaping. */
const MAX_BATCH_BYTES = 16 * 1024 * 1024;
const BATCH_TIMEOUT_MS = 25_000;

export const RUN_FOLLOW_TOKEN_TTL_MS = 60 * 60_000;
const TOKEN_PREFIX = 'mhub_follow_';
const AUDIENCE = 'marimohub:run-follow:v1';

/**
 * Runs inside the job sandbox: relays one bounded batch of the run's notebook stream from the
 * loopback marimo host, so the host token never leaves the sandbox.
 */
export const JOB_FOLLOW_CLIENT = `${HOST_CLIENT_PYTHON}${String.raw`
import signal, sys
from urllib.error import HTTPError
from urllib.parse import quote

# A follower renders outputs only; console text and variable previews would be relayed unseen.
KINDS = "notebook,document,cell,runtime,run,execution,output,input"
# Bytes of event data in one reply. An output that does not fit an empty reply is replaced.
BATCH_LIMIT = 4 * 1024 * 1024
TOO_LARGE = "This output is too large to follow live. It appears when the run finishes."

# Not an OSError: Python 3.9's socket layer mishandles an OSError raised from a signal handler.
class Expired(Exception):
    pass

def reduced(name, data):
    if name != "output":
        return data
    try:
        record = json.loads(data)
        record["output"]["media"] = {"mimetype": "text/plain", "data": TOO_LARGE}
        return json.dumps(record)
    except (ValueError, KeyError, TypeError):
        return data

def batch(response, snapshot):
    result, room = [], BATCH_LIMIT
    def expired(*_):
        raise Expired()
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, 10 if snapshot else 1)
    try:
        for name, event_id, data in frames(response):
            if len(data) > room:
                # Live events carry ids, so the next request can start with this one.
                if result and not snapshot:
                    return result
                data = reduced(name, data)
            room -= len(data)
            result.append({"event": name, "data": data, **({"id": event_id} if event_id else {})})
            if name == "reset" and not snapshot:
                snapshot = True
                signal.setitimer(signal.ITIMER_REAL, 10)
            if snapshot and name == "ready":
                return result
    except Expired:
        pass
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    if snapshot:
        raise RuntimeError("Incomplete host snapshot")
    return result

def main():
    try:
        with open(sys.argv[1]) as file:
            host = json.load(file)
    except (OSError, ValueError):
        return {"gone": True}
    cursor = sys.argv[2] if len(sys.argv) > 2 else ""
    headers = {"Accept": "text/event-stream", **({"Last-Event-ID": cursor} if cursor else {})}
    url = host["url"] + "/notebooks/" + quote(host["notebook_id"], safe="") + "/events?kinds=" + KINDS
    try:
        response = call(url, host["token"], headers=headers, timeout=15)
    except HTTPError:
        raise
    except OSError:
        return {"gone": True}
    with response:
        return {"events": batch(response, snapshot=not cursor)}

if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except Exception:
        print(json.dumps({"error": True}))
`}`;

const RunFollowEventSchema = z.object({
	event: z.string().min(1),
	id: z.string().optional(),
	/** The frame's `data` field, verbatim. */
	data: z.string(),
});
const RunFollowReplySchema = z.union([
	z.object({ events: z.array(RunFollowEventSchema) }),
	z.object({ gone: z.literal(true) }),
]);

export type RunFollowEvent = z.infer<typeof RunFollowEventSchema>;
/** `gone` means the run's marimo host is not serving: it has not started, or it has exited. */
export type RunFollowBatch = { events: RunFollowEvent[] } | { gone: true };

export type LiveJobRun = JobRun & {
	sandbox_id: NonNullable<JobRun['sandbox_id']>;
	live: NonNullable<JobRun['live']>;
};

const hostFile = (run: LiveJobRun, name: string) =>
	`${run.live.workdir}/${HOST_FILES_DIRECTORY}/${name}`;

/** Whether the run executes under a marimo host right now. */
export function isLiveRun(run: JobRun): run is LiveJobRun {
	return run.status === 'running' && run.live !== undefined && run.sandbox_id !== undefined;
}

/**
 * Attach to a live run's sandbox without the create fallback, which could start a replacement
 * for a sandbox that is gone. Undefined when the provider cannot attach.
 */
export function connectRunSandbox(
	provider: SandboxProvider,
	run: LiveJobRun,
): SandboxInstance | undefined {
	return provider.connectExisting?.(run.sandbox_id, {
		reconnectReference: run.reconnect_reference,
	});
}

/** Read the next batch of the run's notebook stream after `cursor`, or a snapshot without one. */
export async function readRunEvents(
	sandbox: SandboxInstance,
	run: LiveJobRun,
	cursor: string | undefined,
	signal?: AbortSignal,
): Promise<RunFollowBatch> {
	const unavailable = () => new UnavailableError('The run event stream is unavailable');
	const command = `python3 -c ${shellQuote(JOB_FOLLOW_CLIENT)} ${shellQuote(hostFile(run, HOST_DESCRIPTOR_FILE))} ${shellQuote(cursor ?? '')}`;
	const result = await withDeadline(
		sandbox.exec(command, { timeout: BATCH_TIMEOUT_MS, maxOutputBytes: MAX_BATCH_BYTES }),
		{ timeoutMs: BATCH_TIMEOUT_MS + 5_000, timeoutError: unavailable, signal },
	);
	if (!result.success) throw unavailable();
	let reply: unknown;
	try {
		reply = JSON.parse(result.stdout);
	} catch {
		throw unavailable();
	}
	const parsed = RunFollowReplySchema.safeParse(reply);
	if (!parsed.success) throw unavailable();
	return parsed.data;
}

/**
 * The page a follower mounts, bound to `url` and `token`. Undefined until the run's marimo host
 * has started and after it exits.
 */
export async function readRunFollowShell(
	sandbox: SandboxInstance,
	run: LiveJobRun,
	target: { url: string; token: string },
): Promise<string | undefined> {
	const path = hostFile(run, FOLLOW_SHELL_FILE);
	const result = sandbox.readFileBounded
		? await sandbox.readFileBounded(path, { maxBytes: MAX_SHELL_BYTES, timeoutMs: 15_000 })
		: await sandbox.readFile(path);
	if (!result.success) {
		if (result.error.code === 'NOT_FOUND') return undefined;
		throw new UnavailableError('The run follow view is unavailable');
	}
	const html =
		result.encoding === 'base64'
			? new TextDecoder().decode(Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0)))
			: result.content;
	if (!html.includes(FOLLOW_URL_PLACEHOLDER) || !html.includes(FOLLOW_TOKEN_PLACEHOLDER)) {
		throw new UnavailableError('The run follow view is unavailable');
	}
	// Both values land inside a JSON string in the page; neither may close it.
	const embed = (value: string) => JSON.stringify(value).slice(1, -1).replaceAll('<', '\\u003c');
	return html
		.replaceAll(FOLLOW_URL_PLACEHOLDER, () => embed(target.url))
		.replaceAll(FOLLOW_TOKEN_PLACEHOLDER, () => embed(target.token));
}

export interface RunFollowTokenClaims {
	audience: typeof AUDIENCE;
	/** Identity as authenticated when the token was issued; access is rechecked on every use. */
	principal: AuthenticatedPrincipal;
	projectId: ProjectId;
	notebookId: NotebookId;
	jobId: JobId;
	runId: RunId;
	expiresAt: number;
}

async function tokenKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${AUDIENCE}:${secret}`),
	);
	return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * A bearer credential for one user to read one run's event stream. The claims are encrypted:
 * the token is handed to a frame that runs notebook-authored scripts, which must not learn
 * the follower's identity from it.
 */
export async function signRunFollowToken(
	input: Omit<RunFollowTokenClaims, 'audience'>,
	secret: string,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(AUDIENCE) },
			await tokenKey(secret),
			new TextEncoder().encode(JSON.stringify({ ...input, audience: AUDIENCE })),
		),
	);
	const token = new Uint8Array(iv.length + sealed.length);
	token.set(iv);
	token.set(sealed, iv.length);
	return `${TOKEN_PREFIX}${toBase64Url(token)}`;
}

export async function verifyRunFollowToken(
	token: string,
	secret: string,
	now = Date.now(),
): Promise<RunFollowTokenClaims | null> {
	if (!token.startsWith(TOKEN_PREFIX) || token.length > 16_384) return null;
	try {
		const bytes = fromBase64Url(token.slice(TOKEN_PREFIX.length));
		const opened = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: bytes.slice(0, 12),
				additionalData: new TextEncoder().encode(AUDIENCE),
			},
			await tokenKey(secret),
			bytes.slice(12),
		);
		const claims = JSON.parse(new TextDecoder().decode(opened)) as RunFollowTokenClaims;
		if (
			claims.audience !== AUDIENCE ||
			!Number.isFinite(claims.expiresAt) ||
			claims.expiresAt <= now
		)
			return null;
		return claims;
	} catch {
		return null;
	}
}
