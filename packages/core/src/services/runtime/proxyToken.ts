/**
 * Signed routing token for `proxy` sandbox-exposure mode.
 *
 * In proxy mode the client reaches a kernel via `…/proxy/<token>/…`. The token is
 * an HMAC-SHA256-signed, URL-safe blob carrying the project + session id — both a
 * tamper-proof routing locator (so the forwarder can load the session in O(1) via
 * `SessionService.getSession`, which needs the project id under the partitioned
 * session layout of plan 029) and a capability that a malicious actor cannot forge
 * for a session they don't own.
 *
 * Deliberately carries NO expiry: the token only *routes*; every forwarded
 * request is independently authorized (session liveness + the caller's project
 * role), so a stale token resolves to a dead session and is rejected there.
 *
 * Uses Web Crypto (`crypto.subtle`) so it runs identically on Node and Workers —
 * no `node:crypto`, keeping `core` vendor- and runtime-agnostic.
 */
import { ProjectId, SessionId } from '../../ids';
import { fromBase64Url, toBase64Url } from '../../internal/base64url';
import { hmacSha256, timingSafeEqual } from '../../internal/hmac';

/** Mint a routing token for a session: `<projectId>.<sessionId>.<base64url(hmac)>`. */
export async function signProxyToken(
	projectId: ProjectId,
	sessionId: SessionId,
	secret: string,
): Promise<string> {
	// Project and session ids never contain `.` (Crockford base32 bodies), so the
	// dot-delimited payload round-trips unambiguously.
	const payload = `${projectId}.${sessionId}`;
	const sig = await hmacSha256(secret, payload);
	return `${payload}.${toBase64Url(sig)}`;
}

/**
 * Verify a routing token and return the project + session id it encodes, or `null`
 * if the token is malformed or its signature does not match.
 */
export async function verifyProxyToken(
	token: string,
	secret: string,
): Promise<{ projectId: ProjectId; sessionId: SessionId } | null> {
	const lastDot = token.lastIndexOf('.');
	if (lastDot <= 0) return null;
	const payload = token.slice(0, lastDot);
	const provided = token.slice(lastDot + 1);
	let providedBytes: Uint8Array;
	try {
		providedBytes = fromBase64Url(provided);
	} catch {
		return null;
	}
	const expected = await hmacSha256(secret, payload);
	if (!timingSafeEqual(expected, providedBytes)) return null;
	// Signature matched, but the encoded ids must still be well-formed — validate at
	// the boundary rather than branding unchecked slices with a cast.
	const parts = payload.split('.');
	if (parts.length !== 2) return null;
	const [projectId, sessionId] = parts;
	if (!ProjectId.is(projectId) || !SessionId.is(sessionId)) return null;
	return { projectId, sessionId };
}
