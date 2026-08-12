import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AesGcmSecretCodec,
	ProjectAlertStore,
	UnavailableError,
	assertVersionMatch,
} from '@marimo-hub/core';
import type { ProjectAlertDispatcher } from '@marimo-hub/core';
import { uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const KEK = '00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100';

describe('project alert destination routes', () => {
	let bucket: MemoryBucket;
	let store: ProjectAlertStore;
	let dispatcher: ProjectAlertDispatcher;
	let request: ReturnType<typeof createTestApi>['request'];
	let pid: string;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		dispatcher = {
			deliver: vi.fn(async () => 'delivered' as const),
			test: vi.fn(async (projectId, id, version) => {
				const [destination] = await store.resolve(projectId, { id });
				if (!destination) throw new Error('Alert destination not found');
				assertVersionMatch(destination.updated_at, version);
				return store.markVerified(projectId, id, destination.updated_at);
			}),
		};
		request = createTestApi({
			bucket,
			deps: { projectAlerts: { store, dispatcher, maxDestinations: 10 } },
		}).request;
		const project = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name: 'Alerts', description: '' }),
			201,
		);
		pid = project.id;
	});

	it('creates disabled redacted destinations with all kinds selected by default', async () => {
		const destination = await expectOk<any>(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/secret',
			}),
			201,
		);

		expect(destination).toMatchObject({
			type: 'slack',
			enabled: false,
			verified_at: null,
			endpoint_host: 'hooks.slack.com',
			webhook_url_set: true,
		});
		expect(destination.kinds).toHaveLength(10);
		expect(destination).not.toHaveProperty('webhook_url');
		expect(
			await expectOk<any[]>(await request('GET', `/projects/${pid}/alert-destinations`)),
		).toEqual([destination]);
	});

	it('requires a successful test before enabling', async () => {
		const destination = await expectOk<any>(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Slack',
				type: 'slack',
				kinds: ['project.deleted'],
				webhook_url: 'https://hooks.slack.com/services/secret',
			}),
			201,
		);
		await expectError(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${destination.id}`,
				{ enabled: true },
				{ 'if-match': destination.updated_at },
			),
			409,
			'CONFLICT',
		);

		const verified = await expectOk<any>(
			await request(
				'POST',
				`/projects/${pid}/alert-destinations/${destination.id}/test`,
				undefined,
				{ 'if-match': destination.updated_at },
			),
		);
		expect(verified.verified_at).not.toBeNull();
		expect(dispatcher.test).toHaveBeenCalledOnce();
		const enabled = await expectOk<any>(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${destination.id}`,
				{ enabled: true },
				{ 'if-match': verified.updated_at },
			),
		);
		expect(enabled.enabled).toBe(true);
	});

	it('tests without an If-Match precondition', async () => {
		const destination = await expectOk<any>(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/secret',
			}),
			201,
		);

		const verified = await expectOk<any>(
			await request('POST', `/projects/${pid}/alert-destinations/${destination.id}/test`),
		);
		expect(verified.verified_at).not.toBeNull();
		expect(dispatcher.test).toHaveBeenCalledWith(
			pid,
			destination.id,
			undefined,
			expect.objectContaining({ kind: 'alert.test' }),
		);
	});

	it('rejects a stale test precondition', async () => {
		const created = await expectOk<any>(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/secret',
			}),
			201,
		);
		await expectOk(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${created.id}`,
				{ name: 'Renamed' },
				{ 'if-match': created.updated_at },
			),
		);

		await expectError(
			await request('POST', `/projects/${pid}/alert-destinations/${created.id}/test`, undefined, {
				'if-match': created.updated_at,
			}),
			412,
			'PRECONDITION_FAILED',
		);
		expect((await store.list(pid as never))[0]?.verified_at).toBeNull();
	});

	it('hides destinations from non-managers', async () => {
		const stranger = createTestApi({
			bucket,
			userId: uid('alert_stranger'),
			deps: { projectAlerts: { store, dispatcher, maxDestinations: 10 } },
		}).request;
		await expectError(await stranger('GET', `/projects/${pid}/alert-destinations`), 403);
	});

	it('returns not found when the Node feature is not wired', async () => {
		const disabled = createTestApi({ bucket }).request;
		await expectError(await disabled('GET', `/projects/${pid}/alert-destinations`), 404);
	});

	it('rejects insecure URLs and empty event selections without creating a destination', async () => {
		await expectError(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Insecure',
				type: 'slack',
				webhook_url: 'http://hooks.example.com/services/secret',
			}),
			422,
			'VALIDATION_ERROR',
		);
		await expectError(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'No events',
				type: 'slack',
				kinds: [],
				webhook_url: 'https://hooks.example.com/services/secret',
			}),
			422,
			'VALIDATION_ERROR',
		);
		expect(
			await expectOk<any[]>(await request('GET', `/projects/${pid}/alert-destinations`)),
		).toEqual([]);
	});

	it('rejects stale updates and deletes while preserving the latest value', async () => {
		const created = await expectOk<any>(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Original',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/secret',
			}),
			201,
		);
		const current = await expectOk<any>(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${created.id}`,
				{ name: 'Current' },
				{ 'if-match': created.updated_at },
			),
		);

		await expectError(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${created.id}`,
				{ name: 'Stale' },
				{ 'if-match': created.updated_at },
			),
			412,
			'PRECONDITION_FAILED',
		);
		await expectError(
			await request('DELETE', `/projects/${pid}/alert-destinations/${created.id}`, undefined, {
				'if-match': created.updated_at,
			}),
			412,
			'PRECONDITION_FAILED',
		);
		expect(
			await expectOk<any[]>(await request('GET', `/projects/${pid}/alert-destinations`)),
		).toEqual([current]);
	});

	it('rejects an empty update without advancing the destination version', async () => {
		const created = await expectOk<any>(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/secret',
			}),
			201,
		);

		await expectError(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${created.id}`,
				{},
				{ 'if-match': created.updated_at },
			),
			422,
			'VALIDATION_ERROR',
		);
		expect((await store.list(pid as never))[0]?.updated_at).toBe(created.updated_at);
	});

	it('endpoint replacement atomically disables and clears verification', async () => {
		const created = await expectOk<any>(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/first',
			}),
			201,
		);
		const verified = await expectOk<any>(
			await request('POST', `/projects/${pid}/alert-destinations/${created.id}/test`, undefined, {
				'if-match': created.updated_at,
			}),
		);
		const enabled = await expectOk<any>(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${created.id}`,
				{ enabled: true },
				{ 'if-match': verified.updated_at },
			),
		);

		await expectError(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${created.id}`,
				{ webhook_url: 'https://hooks.example.com/services/replacement', enabled: true },
				{ 'if-match': enabled.updated_at },
			),
			409,
			'CONFLICT',
		);
		const replaced = await expectOk<any>(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${created.id}`,
				{ webhook_url: 'https://hooks.example.com/services/replacement' },
				{ 'if-match': enabled.updated_at },
			),
		);
		expect(replaced).toMatchObject({
			enabled: false,
			verified_at: null,
			endpoint_host: 'hooks.example.com',
			webhook_url_set: true,
		});
		expect(replaced).not.toHaveProperty('webhook_url');
	});

	it('failed tests leave verification unset and audit without endpoint material', async () => {
		const failingDispatcher: ProjectAlertDispatcher = {
			deliver: vi.fn(async () => 'delivered' as const),
			test: vi.fn(async () => {
				throw new UnavailableError('Alert destination test failed');
			}),
		};
		const local = createTestApi({
			bucket,
			deps: { projectAlerts: { store, dispatcher: failingDispatcher, maxDestinations: 10 } },
		}).request;
		const endpoint = 'https://events.example.com/hooks/private-path';
		const secret = 'audit-secret-must-not-leak';
		const destination = await expectOk<any>(
			await local('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Webhook',
				type: 'webhook',
				url: endpoint,
				signing_secret: secret,
			}),
			201,
		);

		await expectError(
			await local('POST', `/projects/${pid}/alert-destinations/${destination.id}/test`, undefined, {
				'if-match': destination.updated_at,
			}),
			503,
			'SERVICE_UNAVAILABLE',
		);
		expect((await store.list(pid as never))[0]).toMatchObject({
			verified_at: null,
			enabled: false,
		});
		const events = await expectOk<Record<string, unknown>[]>(
			await local('GET', `/projects/${pid}/events`),
		);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: 'project_alert.test',
					outcome: 'failure',
				}),
			]),
		);
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain(endpoint);
		expect(serialized).not.toContain('private-path');
		expect(serialized).not.toContain(secret);
	});

	it('limits failed tests to ten attempts per user per minute', async () => {
		const limiterUser = uid('alert_test_limiter');
		const limiterBucket = await createInitializedBucket();
		const limiterStore = new ProjectAlertStore(limiterBucket, new AesGcmSecretCodec({ kek: KEK }));
		const test = vi.fn(async () => {
			throw new UnavailableError('Alert destination test failed');
		});
		const limiter = createTestApi({
			bucket: limiterBucket,
			userId: limiterUser,
			deps: {
				projectAlerts: {
					store: limiterStore,
					dispatcher: { deliver: vi.fn(async () => 'delivered' as const), test },
					maxDestinations: 10,
				},
			},
		}).request;
		const project = await expectOk<{ id: string }>(
			await limiter('POST', '/projects', { name: 'Rate limit', description: '' }),
			201,
		);
		const destination = await expectOk<any>(
			await limiter('POST', `/projects/${project.id}/alert-destinations`, {
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/rate-limit',
			}),
			201,
		);
		for (let attempt = 0; attempt < 10; attempt++) {
			await expectError(
				await limiter(
					'POST',
					`/projects/${project.id}/alert-destinations/${destination.id}/test`,
					undefined,
					{ 'if-match': destination.updated_at },
				),
				503,
				'SERVICE_UNAVAILABLE',
			);
		}
		await expectError(
			await limiter(
				'POST',
				`/projects/${project.id}/alert-destinations/${destination.id}/test`,
				undefined,
				{ 'if-match': destination.updated_at },
			),
			429,
			'RESOURCE_EXHAUSTED',
		);
		expect(test).toHaveBeenCalledTimes(10);
	});
});
