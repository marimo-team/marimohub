import { fromBase64Url, toBase64Url } from '../../internal/base64url';
import { describe, expect, it } from 'vitest';
import { ACTOR } from '../../testing/fixtures';
import {
	APP_JOB_CREDENTIAL_TTL_MS,
	signAppJobCredential,
	verifyAppJobCredential,
} from './appJobCredential';

const secret = 'test-secret';
const endpoint = 'https://hub.test/api/app-jobs/v1';
const input = {
	principal: { id: ACTOR, email: 'user@example.com', credential: { kind: 'sso' as const } },
	routingToken: 'project.session.signature',
	assignmentGenerations: ['generation'],
	endpoint,
	refreshUntil: 3_600_000,
};

describe('app job credentials', () => {
	it('binds identity and audience, rejects forgery and expiration', async () => {
		const token = await signAppJobCredential(input, secret, 0);
		expect(
			(await verifyAppJobCredential(token, secret, endpoint, { purpose: 'access', now: 1 }))
				?.principal.id,
		).toBe(ACTOR);
		expect(
			await verifyAppJobCredential(token, 'wrong', endpoint, { purpose: 'access', now: 1 }),
		).toBeNull();
		expect(
			await verifyAppJobCredential(token, secret, 'https://other.test', {
				purpose: 'access',
				now: 1,
			}),
		).toBeNull();
		expect(
			await verifyAppJobCredential(`${token}x`, secret, endpoint, { purpose: 'access', now: 1 }),
		).toBeNull();
		expect(
			await verifyAppJobCredential(token, secret, endpoint, {
				purpose: 'access',
				now: APP_JOB_CREDENTIAL_TTL_MS,
			}),
		).toBeNull();
		expect(
			await verifyAppJobCredential(token, secret, endpoint, {
				purpose: 'refresh',
				now: APP_JOB_CREDENTIAL_TTL_MS,
			}),
		).not.toBeNull();
		expect(
			await verifyAppJobCredential(token, secret, endpoint, {
				purpose: 'refresh',
				now: input.refreshUntil,
			}),
		).toBeNull();
	});
	it('encrypts the visitor identity so notebook code cannot read it', async () => {
		const token = await signAppJobCredential(
			{ ...input, principal: { ...input.principal, groups: ['finance-admins'] } },
			secret,
			0,
		);
		const body = token.slice('mhub_app_'.length);
		const decoded = body
			.split('.')
			.map((part) => new TextDecoder('latin1').decode(fromBase64Url(part)))
			.join('.');
		for (const text of [body, decoded, token]) {
			expect(text).not.toContain('user@example.com');
			expect(text).not.toContain(ACTOR);
			expect(text).not.toContain('finance-admins');
		}
		expect(await signAppJobCredential(input, secret, 0)).not.toBe(
			await signAppJobCredential(input, secret, 0),
		);
	});

	it('rejects a modified ciphertext or nonce', async () => {
		const token = await signAppJobCredential(input, secret, 0);
		const [iv, ciphertext] = token.slice('mhub_app_'.length).split('.');
		const flip = (part: string) => {
			const bytes = fromBase64Url(part);
			bytes[0] ^= 1;
			return toBase64Url(bytes);
		};
		for (const forged of [
			`mhub_app_${flip(iv)}.${ciphertext}`,
			`mhub_app_${iv}.${flip(ciphertext)}`,
			`mhub_app_${iv.slice(2)}.${ciphertext}`,
		]) {
			expect(
				await verifyAppJobCredential(forged, secret, endpoint, { purpose: 'access', now: 1 }),
			).toBeNull();
		}
	});

	it.each([Number.NaN, Infinity, -1, 0])(
		'rejects an invalid or elapsed refresh deadline (%s)',
		async (refreshUntil) => {
			const token = await signAppJobCredential({ ...input, refreshUntil }, secret, 0);
			expect(
				await verifyAppJobCredential(token, secret, endpoint, { purpose: 'refresh', now: 1 }),
			).toBeNull();
		},
	);

	it('renewal preserves the original refresh deadline', async () => {
		const token = await signAppJobCredential(input, secret, 0);
		const claims = (await verifyAppJobCredential(token, secret, endpoint, {
			purpose: 'refresh',
			now: 100,
		}))!;
		const renewed = await signAppJobCredential(claims, secret, input.refreshUntil - 1);
		expect(
			await verifyAppJobCredential(renewed, secret, endpoint, {
				purpose: 'access',
				now: input.refreshUntil,
			}),
		).toBeNull();
	});
});
