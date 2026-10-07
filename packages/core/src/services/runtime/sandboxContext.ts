import { withDeadline } from '../../async';
import type { SessionMode } from '../../constants';
import { UnavailableError } from '../../errors';
import type { SandboxId } from '../../ids';
import { utf8ToBase64Url } from '../../internal/base64url';
import type { SandboxInstance } from '../../ports/sandbox';
import type { SandboxExposureMode } from '../../ports/sandboxExposure';
import type { Session } from '../../schema';
import { sessionResourcePath } from '../../sessionOrigin';
import { joinUrlPath } from '../../url';
import { shellQuote } from './shell';
import type { PersistenceMode } from './sessionPersistence';

/** Appears verbatim in the publication command, so tests can recognise it. */
export const SANDBOX_CONTEXT_COMMAND_MARKER = '# marimohub-sandbox-context';

const WRITE_CONTEXT = `${SANDBOX_CONTEXT_COMMAND_MARKER}
import base64,pathlib,sys
def decode(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
path = pathlib.Path(decode(sys.argv[1]).decode('utf-8'))
path.parent.mkdir(parents=True, exist_ok=True)
temporary = path.with_name(path.name + '.tmp')
temporary.write_bytes(decode(sys.argv[2]))
temporary.replace(path)
`;

// The context is optional metadata on the critical path before `mark_running`;
// a hung adapter exec must not hold the session in `starting`.
const WRITE_CONTEXT_TIMEOUT_MS = 15_000;

export interface SandboxContext {
	schema_version: 1;
	public_url: string;
	notebook_url: string;
	exposure_mode: SandboxExposureMode;
	persistence_mode: PersistenceMode;
	session_mode: SessionMode;
}

export interface SandboxContextInput {
	session: Pick<Session, 'project_id' | 'notebook_id' | 'origin'>;
	sessionMode: SessionMode;
	appBaseUrl: string;
	publicUrl: string;
	exposureMode: SandboxExposureMode;
	persistence: PersistenceMode;
}

export function buildSandboxContext(input: SandboxContextInput): SandboxContext {
	return {
		schema_version: 1,
		public_url: input.publicUrl,
		notebook_url: joinUrlPath(input.appBaseUrl, sessionResourcePath(input.session)),
		exposure_mode: input.exposureMode,
		persistence_mode: input.persistence,
		session_mode: input.sessionMode,
	};
}

export function sandboxContextPath(sandboxId: SandboxId): string {
	// A restored filesystem can contain the previous session's context.
	return `/tmp/marimohub-context/${sandboxId}.json`;
}

export function sandboxContextFile(
	sandboxId: SandboxId,
	context: SandboxContext,
): { path: string; content: string } {
	const publicUrl = new URL(context.public_url);
	publicUrl.username = '';
	publicUrl.password = '';
	publicUrl.search = '';
	publicUrl.hash = '';
	return {
		path: sandboxContextPath(sandboxId),
		content: JSON.stringify({ ...context, public_url: publicUrl.href }),
	};
}

export async function writeSandboxContext(
	sandbox: SandboxInstance,
	sandboxId: SandboxId,
	context: SandboxContext,
): Promise<void> {
	const file = sandboxContextFile(sandboxId, context);
	const path = sandbox.resolveProcessPath?.(file.path) ?? file.path;
	// The content rides argv (not writeFile) so the write and rename are one
	// atomic command; keep the document small. Both arguments are encoded so
	// adapter path rewriting cannot alter them. `-I` keeps a workspace module
	// such as `base64.py` from shadowing the standard library.
	const result = await withDeadline(
		sandbox.exec(
			`python3 -I -c ${shellQuote(WRITE_CONTEXT)} ${shellQuote(utf8ToBase64Url(path))} ${shellQuote(utf8ToBase64Url(file.content))}`,
			{ timeout: WRITE_CONTEXT_TIMEOUT_MS },
		),
		{
			timeoutMs: WRITE_CONTEXT_TIMEOUT_MS,
			timeoutError: () => new UnavailableError('Publishing sandbox context timed out'),
		},
	);
	if (!result.success) {
		const detail = result.stderr.trim().slice(-2000);
		throw new UnavailableError(
			detail ? `Failed to publish sandbox context: ${detail}` : 'Failed to publish sandbox context',
		);
	}
}
