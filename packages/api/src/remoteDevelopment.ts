import {
	asSandboxPortConnector,
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotebookId,
	NotFoundError,
	ProjectId,
	SessionId,
	UnavailableError,
	workspaceSourcePolicy,
} from '@marimo-hub/core';
import type { AuthSubject, AuthUser, Session } from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { assertSessionDevelopmentAccess } from './shared';

export const SSH_PORT = 2222;
export const SSH_KEY_TTL_MS = 10 * 60_000;
export const DEVELOPMENT_LEASE_MS = 90_000;

export type SshAvailabilityReason =
	| 'disabled'
	| 'unsupported_backend'
	| 'unsupported_image'
	| 'restart_required';

export type SshAvailability =
	| { available: true }
	| { available: false; reason: SshAvailabilityReason };

export function sshAvailability(deps: ApiDeps, session: Session): SshAvailability {
	const config = deps.sandbox.remoteDevelopment;
	if (!config) return { available: false, reason: 'disabled' };
	if (!asSandboxPortConnector(deps.compute)) {
		return { available: false, reason: 'unsupported_backend' };
	}
	if (!session.sandbox_image) return { available: false, reason: 'restart_required' };
	if (!config.images.includes(session.sandbox_image)) {
		return { available: false, reason: 'unsupported_image' };
	}
	return { available: true };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function isEd25519PublicKey(publicKey: string): boolean {
	const parts = publicKey.trim().split(/[ \t]+/);
	let decoded: Uint8Array | undefined;
	try {
		if (parts[0] === 'ssh-ed25519' && /^[A-Za-z0-9+/]+={0,2}$/.test(parts[1] ?? '')) {
			decoded = Uint8Array.from(atob(parts[1]), (character) => character.charCodeAt(0));
		}
	} catch {
		decoded = undefined;
	}
	const view = decoded && new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
	const algorithmLength = decoded && view && decoded.length >= 4 ? view.getUint32(0) : 0;
	const keyLengthOffset = 4 + algorithmLength;
	const keyLength =
		decoded && view && decoded.length >= keyLengthOffset + 4 ? view.getUint32(keyLengthOffset) : 0;
	const algorithm = decoded && new TextDecoder().decode(decoded.subarray(4, keyLengthOffset));
	return !(
		publicKey.length > 1_024 ||
		publicKey.includes('\r') ||
		publicKey.includes('\n') ||
		algorithm !== 'ssh-ed25519' ||
		keyLength !== 32 ||
		decoded?.length !== keyLengthOffset + 4 + keyLength
	);
}

function assertEd25519PublicKey(publicKey: string): void {
	if (!isEd25519PublicKey(publicKey)) {
		throw new BadRequestError('A valid Ed25519 SSH public key is required');
	}
}

export interface PreparedSshAccess {
	username: string;
	workspace_path: string;
	host_key: string;
	key_expires_at: string;
	persistence: 'workspace' | 'source' | 'none';
}

export async function prepareSshAccess(
	deps: ApiDeps,
	user: AuthUser,
	session: Session,
	publicKey: string,
): Promise<PreparedSshAccess> {
	assertEd25519PublicKey(publicKey);
	const availability = sshAvailability(deps, session);
	if (!availability.available) {
		throw new ConflictError(`SSH access is unavailable: ${availability.reason}`);
	}
	if (!session.sandbox_id) throw new ConflictError('The running session has no sandbox');

	const project = await deps.services.projects.getProject(session.project_id);
	assertSessionDevelopmentAccess(project, session, user, deps.policy);
	const notebook = await deps.services.notebooks.getNotebook(
		session.project_id,
		session.notebook_id,
	);
	const sourcePersists = workspaceSourcePolicy(notebook.source).persistSessionEdits;
	const persistence = sourcePersists ? deps.sandbox.persistWorkspace : 'none';
	const authorizationDeadline = session.authorization_expires_at
		? Date.parse(session.authorization_expires_at)
		: Number.POSITIVE_INFINITY;
	const expiresAt = new Date(Math.min(Date.now() + SSH_KEY_TTL_MS, authorizationDeadline));
	if (expiresAt.getTime() <= Date.now())
		throw new ForbiddenError('Session authorization has expired');

	const keyPath = `/tmp/marimohub-ssh/${session.session_id}.pub`;
	const sandbox = deps.compute.create(session.sandbox_id);
	await sandbox.writeFiles([{ path: keyPath, content: `${publicKey.trim()}\n` }]);
	const result = await sandbox.exec(
		[
			'marimohub-ssh prepare',
			`--public-key-file ${shellQuote(keyPath)}`,
			`--expires-at ${shellQuote(expiresAt.toISOString())}`,
			`--workspace ${shellQuote(deps.sandbox.workdir)}`,
		].join(' '),
	);
	if (!result.success) {
		throw new ConflictError(
			'The selected sandbox image does not satisfy the remote-development contract',
		);
	}
	let prepared: { username?: unknown; host_key?: unknown };
	try {
		prepared = JSON.parse(result.stdout.trim()) as { username?: unknown; host_key?: unknown };
	} catch {
		throw new UnavailableError('The sandbox returned an invalid SSH preparation response');
	}
	if (
		typeof prepared.username !== 'string' ||
		!/^[a-z_][a-z0-9_-]{0,31}$/i.test(prepared.username) ||
		typeof prepared.host_key !== 'string' ||
		!isEd25519PublicKey(prepared.host_key)
	) {
		throw new UnavailableError('The sandbox returned an invalid SSH identity');
	}
	return {
		username: prepared.username,
		workspace_path: deps.sandbox.workdir,
		host_key: prepared.host_key,
		key_expires_at: expiresAt.toISOString(),
		persistence,
	};
}

export type RemoteDevelopmentDecision =
	| { kind: 'pass' }
	| { kind: 'reject'; status: 401 | 403 | 404 | 409 | 410 | 503; message: string }
	| { kind: 'connect'; session: Session; user: AuthSubject; port: number };

const RELAY_PATH =
	/^\/api\/v1\/projects\/([^/]+)\/notebooks\/([^/]+)\/sessions\/([^/]+)\/remote-development\/ssh\/relay$/;

export async function authorizeRemoteDevelopmentRequest(
	request: Request,
	deps: ApiDeps,
): Promise<RemoteDevelopmentDecision> {
	const match = RELAY_PATH.exec(new URL(request.url).pathname);
	if (!match) return { kind: 'pass' };
	const [, rawPid, rawNid, rawSid] = match;
	if (!ProjectId.is(rawPid) || !NotebookId.is(rawNid) || !SessionId.is(rawSid)) {
		return { kind: 'reject', status: 404, message: 'Session not found' };
	}
	if (!/^Bearer \S+$/i.test(request.headers.get('authorization') ?? '')) {
		return { kind: 'reject', status: 401, message: 'Authentication required' };
	}
	const user = await deps.authenticator.authenticate(request);
	if (!user) return { kind: 'reject', status: 401, message: 'Authentication required' };
	try {
		if (await deps.services.identities.isSuspended(user.id)) {
			return { kind: 'reject', status: 403, message: 'User account is suspended' };
		}
	} catch {
		return { kind: 'reject', status: 503, message: 'Unable to verify account status' };
	}
	let session: Session;
	try {
		session = await deps.services.sessions.getSession(rawPid, rawSid);
	} catch (error) {
		if (error instanceof NotFoundError) {
			return { kind: 'reject', status: 404, message: 'Session not found' };
		}
		throw error;
	}
	if (session.notebook_id !== rawNid) {
		return { kind: 'reject', status: 404, message: 'Session not found' };
	}
	if (session.status !== 'running') {
		return { kind: 'reject', status: 410, message: 'Session is no longer running' };
	}
	if (
		session.authorization_expires_at &&
		Date.now() >= Date.parse(session.authorization_expires_at)
	) {
		return { kind: 'reject', status: 410, message: 'Session authorization has expired' };
	}
	const availability = sshAvailability(deps, session);
	if (!availability.available) {
		return {
			kind: 'reject',
			status: 409,
			message: `SSH access is unavailable: ${availability.reason}`,
		};
	}
	const project = await deps.services.projects.getProject(rawPid).catch(() => null);
	if (!project || project.status === 'deleted') {
		return { kind: 'reject', status: 404, message: 'Session not found' };
	}
	try {
		assertSessionDevelopmentAccess(project, session, user, deps.policy);
	} catch (error) {
		if (error instanceof ForbiddenError) {
			return { kind: 'reject', status: 403, message: error.message };
		}
		throw error;
	}
	return { kind: 'connect', session, user, port: deps.sandbox.remoteDevelopment!.port };
}
