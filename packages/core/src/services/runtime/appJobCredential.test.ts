import { hmacSha256 } from '../../internal/hmac';
import { toBase64Url, utf8ToBase64Url } from '../../internal/base64url';
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
	it('rejects a correctly signed credential for a different audience', async () => {
		const payload = utf8ToBase64Url(
			JSON.stringify({ ...input, audience: 'another-service', expiresAt: 1000 }),
		);
		const signature = toBase64Url(await hmacSha256(secret, `marimohub:app-jobs:v1:${payload}`));
		expect(
			await verifyAppJobCredential(`mhub_app_${payload}.${signature}`, secret, endpoint, {
				purpose: 'access',
				now: 1,
			}),
		).toBeNull();
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
