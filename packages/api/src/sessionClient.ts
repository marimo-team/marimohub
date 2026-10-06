import type { CredentialKind } from '@marimo-hub/core';
import { authMethodFor } from './shared';

export type SessionClient = 'mcp' | 'cli' | 'web';

/** MCP wins; any other token-authenticated caller is a CLI or script; interactive sessions are web. */
export function sessionClientFor(
	credentialKind: CredentialKind,
	via: 'mcp' | 'rest',
): SessionClient {
	if (via === 'mcp') return 'mcp';
	return authMethodFor(credentialKind) === 'pat' ? 'cli' : 'web';
}
