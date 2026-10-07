import type { SessionMode } from '../../constants';
import { UnavailableError } from '../../errors';
import type { SandboxId } from '../../ids';
import { utf8ToBase64Url } from '../../internal/base64url';
import type { SandboxInstance } from '../../ports/sandbox';
import type { SandboxExposureMode } from '../../ports/sandboxExposure';
import { shellQuote } from './shell';

const WRITE_CONTEXT = `import base64,pathlib,sys
def decode(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
path = pathlib.Path(decode(sys.argv[1]).decode('utf-8'))
path.parent.mkdir(parents=True, exist_ok=True)
temporary = path.with_name(path.name + '.tmp')
temporary.write_bytes(decode(sys.argv[2]))
temporary.replace(path)
`;

export interface SandboxContext {
	public_url: string;
	notebook_url: string;
	exposure_mode: SandboxExposureMode;
	persistence_mode: 'source' | 'workspace' | 'none';
	session_mode: SessionMode;
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
	// Encode both arguments so adapter path rewriting cannot alter them.
	const result = await sandbox.exec(
		`python3 -c ${shellQuote(WRITE_CONTEXT)} ${shellQuote(utf8ToBase64Url(path))} ${shellQuote(utf8ToBase64Url(file.content))}`,
	);
	if (!result.success) {
		const detail = result.stderr.trim().slice(-2000);
		throw new UnavailableError(
			detail ? `Failed to publish sandbox context: ${detail}` : 'Failed to publish sandbox context',
		);
	}
}
