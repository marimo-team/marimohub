import { describe, expect, it } from 'vitest';
import { ProjectId, SessionId } from '../../ids';
import { toBase64Url } from '../../internal/base64url';
import { hmacSha256 } from '../../internal/hmac';
import { signProxyToken, verifyProxyToken } from './proxyToken';

const SECRET = 'a-test-signing-secret-at-least-32-bytes-long!!';
const PROJECT = ProjectId.create();
const SESSION = SessionId.create();

describe('proxy routing token', () => {
	it('round-trips a project + session id', async () => {
		const token = await signProxyToken(PROJECT, SESSION, SECRET);
		expect(token.startsWith(`${PROJECT}.${SESSION}.`)).toBe(true);
		expect(await verifyProxyToken(token, SECRET)).toEqual({
			projectId: PROJECT,
			sessionId: SESSION,
		});
	});

	it('is deterministic for the same ids + secret', async () => {
		// prepare() and finalize() both re-mint the token; they must agree.
		expect(await signProxyToken(PROJECT, SESSION, SECRET)).toBe(
			await signProxyToken(PROJECT, SESSION, SECRET),
		);
	});

	it('is URL-safe (no +, /, or = in the signature segment)', async () => {
		const token = await signProxyToken(PROJECT, SESSION, SECRET);
		const sig = token.slice(token.lastIndexOf('.') + 1);
		expect(sig).not.toMatch(/[+/=]/);
	});

	it('rejects a token signed with a different secret', async () => {
		const token = await signProxyToken(PROJECT, SESSION, SECRET);
		expect(await verifyProxyToken(token, 'a-different-secret-of-sufficient-length!')).toBeNull();
	});

	it('rejects a tampered id (signature no longer matches)', async () => {
		const token = await signProxyToken(PROJECT, SESSION, SECRET);
		const sig = token.slice(token.lastIndexOf('.') + 1);
		expect(await verifyProxyToken(`${PROJECT}.sess-evil.${sig}`, SECRET)).toBeNull();
	});

	it('rejects malformed tokens', async () => {
		expect(await verifyProxyToken('no-dot', SECRET)).toBeNull();
		expect(await verifyProxyToken('', SECRET)).toBeNull();
		expect(await verifyProxyToken('.sig', SECRET)).toBeNull();
		// A single id segment (missing the project or session half) fails validation.
		const token = await signProxyToken(PROJECT, SESSION, SECRET);
		const sig = token.slice(token.lastIndexOf('.') + 1);
		expect(await verifyProxyToken(`${SESSION}.${sig}`, SECRET)).toBeNull();
	});

	it('rejects a valid-base64url signature of the wrong byte length', async () => {
		// Decodes cleanly (so it passes the fromBase64Url guard) but is 16 bytes, not
		// the 32-byte HMAC digest — timingSafeEqual must reject on the length branch
		// rather than reading past the shorter array.
		const shortSig = toBase64Url(new Uint8Array(16));
		expect(await verifyProxyToken(`${PROJECT}.${SESSION}.${shortSig}`, SECRET)).toBeNull();
	});

	it('rejects a token whose payload has more than two id segments (a.b.c.<sig>)', async () => {
		// Sign a legitimately-3-segment payload so the signature check passes; the
		// boundary parse (`parts.length !== 2`) must still reject it.
		const payload = `${PROJECT}.${SESSION}.${SESSION}`;
		const sig = toBase64Url(await hmacSha256(SECRET, payload));
		expect(await verifyProxyToken(`${payload}.${sig}`, SECRET)).toBeNull();
	});
});
