import { describe, expect, it } from 'vitest';
import { ProjectId, SessionId } from '../../ids';
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
});
