import { describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import { createNotebookId, createProjectId, createSessionId } from '../../ids';
import { openPublicAppVisitToken, sealPublicAppVisitToken } from './publicAppVisitToken';

describe('publicAppVisitToken', () => {
	const secret = 'test-public-app-visit-secret-at-least-32-bytes';
	const claims = () => ({
		slug: 'team/sales',
		reg: ulid(),
		grant: ulid(),
		pid: createProjectId(),
		nid: createNotebookId(),
		sid: createSessionId(),
		vid: 'visit-123',
		gen: 'gen-456',
		exp: Math.floor(Date.now() / 1000) + 600,
	});

	it('seals and opens opaque tokens without exposing plaintext IDs', async () => {
		const original = claims();
		const token = await sealPublicAppVisitToken(original, secret);
		expect(token.startsWith('v1.')).toBe(true);
		expect(token).not.toContain(original.pid);
		expect(token).not.toContain(original.nid);
		expect(token).not.toContain(original.sid);
		expect(token).not.toContain(original.slug);
		const opened = await openPublicAppVisitToken(token, secret);
		expect(opened).toEqual(original);
	});

	it('produces distinct ciphertexts for identical claims (fresh IV)', async () => {
		const original = claims();
		const a = await sealPublicAppVisitToken(original, secret);
		const b = await sealPublicAppVisitToken(original, secret);
		expect(a).not.toBe(b);
	});

	it('rejects wrong secret, tampering, and expiry', async () => {
		const original = claims();
		const token = await sealPublicAppVisitToken(original, secret);
		expect(await openPublicAppVisitToken(token, `${secret}-wrong`)).toBeNull();
		const tampered = `${token.slice(0, -4)}AAAA`;
		expect(await openPublicAppVisitToken(tampered, secret)).toBeNull();
		expect(await openPublicAppVisitToken(token, secret, (original.exp + 1) * 1000)).toBeNull();
	});
});
