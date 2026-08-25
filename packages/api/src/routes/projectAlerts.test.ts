import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AesGcmSecretCodec,
	ProjectAlertStore,
	UnavailableError,
	assertVersionMatch,
} from '@marimo-hub/core';
import type { ProjectAlertDispatcher, UserId } from '@marimo-hub/core';
import { uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const KEK = '00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100';
let testKeySequence = 0;

function alertTestHeaders(updatedAt?: string, idempotencyKey?: string) {
	return {
		'idempotency-key': idempotencyKey ?? `alert-test-${++testKeySequence}`,
		...(updatedAt ? { 'if-match': updatedAt } : {}),
	};
}

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

	async function createLocalDestination(
		userId: UserId,
		localDispatcher: ProjectAlertDispatcher = dispatcher,
	) {
		const api = createTestApi({
			bucket,
			userId,
			deps: { projectAlerts: { store, dispatcher: localDispatcher, maxDestinations: 10 } },
		});
		const project = await expectOk<{ id: string }>(
			await api.request('POST', '/projects', { name: `Alerts ${userId}`, description: '' }),
			201,
		);
		const destination = await expectOk<any>(
			await api.request('POST', `/projects/${project.id}/alert-destinations`, {
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/local',
			}),
			201,
		);
		return { ...api, pid: project.id, destination };
	}

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
			await expectOk<{ items: any[]; next_cursor: string | null }>(
				await request('GET', `/projects/${pid}/alert-destinations`),
			),
		).toEqual({ items: [destination], next_cursor: null });
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
				{ type: 'slack', enabled: true },
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
				alertTestHeaders(destination.updated_at),
			),
		);
		expect(verified.verified_at).not.toBeNull();
		expect(dispatcher.test).toHaveBeenCalledOnce();
		const enabled = await expectOk<any>(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${destination.id}`,
				{ type: 'slack', enabled: true },
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
			await request(
				'POST',
				`/projects/${pid}/alert-destinations/${destination.id}/test`,
				undefined,
				alertTestHeaders(),
			),
		);
		expect(verified.verified_at).not.toBeNull();
		expect(dispatcher.test).toHaveBeenCalledWith(
			pid,
			destination.id,
			undefined,
			expect.objectContaining({ kind: 'alert.test' }),
		);
	});

	it('requires an idempotency key for a test delivery', async () => {
		const destination = await expectOk<any>(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/secret',
			}),
			201,
		);

		await expectError(
			await request('POST', `/projects/${pid}/alert-destinations/${destination.id}/test`),
			422,
			'VALIDATION_ERROR',
		);
		expect(dispatcher.test).not.toHaveBeenCalled();
	});

	it('replays a successful test without sending another external message', async () => {
		const destination = await expectOk<any>(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/secret',
			}),
			201,
		);
		const headers = alertTestHeaders(destination.updated_at, 'replay-test-delivery');
		const path = `/projects/${pid}/alert-destinations/${destination.id}/test`;

		const firstResponse = await request('POST', path, undefined, headers);
		const first = await expectOk<any>(firstResponse);
		const replayResponse = await request('POST', path, undefined, headers);
		const replay = await expectOk<any>(replayResponse);

		expect(replay).toEqual(first);
		expect(replayResponse.headers.get('etag')).toBe(firstResponse.headers.get('etag'));
		expect(dispatcher.test).toHaveBeenCalledOnce();
	});

	it('allows only one concurrent delivery for the same idempotency key', async () => {
		let releaseTest!: () => void;
		const testGate = new Promise<void>((resolve) => {
			releaseTest = resolve;
		});
		const test = vi.fn<ProjectAlertDispatcher['test']>(
			async (projectId, destinationId, expectedVersion) => {
				await testGate;
				const [resolved] = await store.resolve(projectId, { id: destinationId });
				if (!resolved) throw new Error('Alert destination not found');
				assertVersionMatch(resolved.updated_at, expectedVersion);
				return store.markVerified(projectId, destinationId, resolved.updated_at);
			},
		);
		const localDispatcher: ProjectAlertDispatcher = {
			deliver: vi.fn(async () => 'delivered' as const),
			test,
		};
		const local = await createLocalDestination(uid('alert_concurrent_test'), localDispatcher);
		const path = `/projects/${local.pid}/alert-destinations/${local.destination.id}/test`;
		const headers = alertTestHeaders(local.destination.updated_at, 'concurrent-delivery');

		const firstResponse = local.request('POST', path, undefined, headers);
		await vi.waitFor(() => expect(test).toHaveBeenCalledOnce());
		await expectError(await local.request('POST', path, undefined, headers), 409, 'CONFLICT');
		releaseTest();
		const first = await expectOk<any>(await firstResponse);
		const replay = await expectOk<any>(await local.request('POST', path, undefined, headers));

		expect(replay).toEqual(first);
		expect(test).toHaveBeenCalledOnce();
	});

	it('does not redeliver when persisting the completed result fails', async () => {
		const local = await createLocalDestination(uid('alert_result_failure'));
		const record = vi
			.spyOn(local.deps.services.idempotency, 'record')
			.mockRejectedValueOnce(new Error('result storage unavailable'));
		const path = `/projects/${local.pid}/alert-destinations/${local.destination.id}/test`;
		const headers = alertTestHeaders(local.destination.updated_at, 'result-record-failure');

		await expectError(await local.request('POST', path, undefined, headers), 500, 'INTERNAL_ERROR');
		await expectError(await local.request('POST', path, undefined, headers), 409, 'CONFLICT');

		expect(record).toHaveBeenCalledOnce();
		expect(dispatcher.test).toHaveBeenCalledOnce();
	});

	it('records the completed result when best-effort success auditing fails', async () => {
		const local = await createLocalDestination(uid('alert_audit_failure'));
		const append = vi
			.spyOn(local.deps.services.events, 'append')
			.mockRejectedValueOnce(new Error('audit storage unavailable'));
		const path = `/projects/${local.pid}/alert-destinations/${local.destination.id}/test`;
		const headers = alertTestHeaders(local.destination.updated_at, 'success-audit-failure');

		const first = await expectOk<any>(await local.request('POST', path, undefined, headers));
		const replay = await expectOk<any>(await local.request('POST', path, undefined, headers));

		expect(replay).toEqual(first);
		expect(append).toHaveBeenCalledOnce();
		expect(dispatcher.test).toHaveBeenCalledOnce();
	});

	it('scopes an idempotency key to one project destination', async () => {
		const resourceUser = uid('alert_resource_scope');
		const local = createTestApi({
			bucket,
			userId: resourceUser,
			deps: { projectAlerts: { store, dispatcher, maxDestinations: 10 } },
		}).request;
		const project = await expectOk<{ id: string }>(
			await local('POST', '/projects', { name: 'Resource scope', description: '' }),
			201,
		);
		const first = await expectOk<any>(
			await local('POST', `/projects/${project.id}/alert-destinations`, {
				name: 'First',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/first',
			}),
			201,
		);
		const second = await expectOk<any>(
			await local('POST', `/projects/${project.id}/alert-destinations`, {
				name: 'Second',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/second',
			}),
			201,
		);
		const idempotencyKey = 'same-key-for-two-destinations';

		const testedFirst = await expectOk<any>(
			await local(
				'POST',
				`/projects/${project.id}/alert-destinations/${first.id}/test`,
				undefined,
				alertTestHeaders(first.updated_at, idempotencyKey),
			),
		);
		const testedSecond = await expectOk<any>(
			await local(
				'POST',
				`/projects/${project.id}/alert-destinations/${second.id}/test`,
				undefined,
				alertTestHeaders(second.updated_at, idempotencyKey),
			),
		);

		expect(testedFirst.id).toBe(first.id);
		expect(testedSecond.id).toBe(second.id);
		expect(dispatcher.test).toHaveBeenCalledTimes(2);
	});

	it('gives different delivery dedupe keys to different users reusing one client key', async () => {
		const firstUser = uid('alert_test_first_manager');
		const secondUser = uid('alert_test_second_manager');
		const firstManager = createTestApi({
			bucket,
			userId: firstUser,
			deps: { projectAlerts: { store, dispatcher, maxDestinations: 10 } },
		}).request;
		const secondManager = createTestApi({
			bucket,
			userId: secondUser,
			deps: { projectAlerts: { store, dispatcher, maxDestinations: 10 } },
		}).request;
		const project = await expectOk<{ id: string }>(
			await firstManager('POST', '/projects', { name: 'User scope', description: '' }),
			201,
		);
		await expectOk(
			await firstManager('POST', `/projects/${project.id}/members`, {
				user_id: secondUser,
				role: 'manager',
			}),
			201,
		);
		const destination = await expectOk<any>(
			await firstManager('POST', `/projects/${project.id}/alert-destinations`, {
				name: 'Shared',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/shared',
			}),
			201,
		);
		const idempotencyKey = 'same-key-for-two-users';
		const tested = await expectOk<any>(
			await firstManager(
				'POST',
				`/projects/${project.id}/alert-destinations/${destination.id}/test`,
				undefined,
				alertTestHeaders(destination.updated_at, idempotencyKey),
			),
		);
		await expectOk(
			await secondManager(
				'POST',
				`/projects/${project.id}/alert-destinations/${destination.id}/test`,
				undefined,
				alertTestHeaders(tested.updated_at, idempotencyKey),
			),
		);

		const testCalls = vi.mocked(dispatcher.test).mock.calls;
		expect(testCalls).toHaveLength(2);
		expect(testCalls[0]?.[3].dedupe_key).not.toBe(testCalls[1]?.[3].dedupe_key);
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
				{ type: 'slack', name: 'Renamed' },
				{ 'if-match': created.updated_at },
			),
		);

		await expectError(
			await request(
				'POST',
				`/projects/${pid}/alert-destinations/${created.id}/test`,
				undefined,
				alertTestHeaders(created.updated_at),
			),
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
			await expectOk<{ items: any[]; next_cursor: string | null }>(
				await request('GET', `/projects/${pid}/alert-destinations`),
			),
		).toEqual({ items: [], next_cursor: null });
	});

	it('rejects destination fields that do not match the discriminated type', async () => {
		await expectError(
			await request('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Mixed',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/secret',
				url: 'https://events.example.com/hook',
			}),
			422,
			'VALIDATION_ERROR',
		);
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
				{ type: 'webhook', name: 'Still Slack' },
				{ 'if-match': created.updated_at },
			),
			422,
			'VALIDATION_ERROR',
		);
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
				{ type: 'slack', name: 'Current' },
				{ 'if-match': created.updated_at },
			),
		);

		await expectError(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${created.id}`,
				{ type: 'slack', name: 'Stale' },
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
			await expectOk<{ items: any[]; next_cursor: string | null }>(
				await request('GET', `/projects/${pid}/alert-destinations`),
			),
		).toEqual({ items: [current], next_cursor: null });
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
				{ type: 'slack' },
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
			await request(
				'POST',
				`/projects/${pid}/alert-destinations/${created.id}/test`,
				undefined,
				alertTestHeaders(created.updated_at),
			),
		);
		const enabled = await expectOk<any>(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${created.id}`,
				{ type: 'slack', enabled: true },
				{ 'if-match': verified.updated_at },
			),
		);

		await expectError(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${created.id}`,
				{
					type: 'slack',
					webhook_url: 'https://hooks.example.com/services/replacement',
					enabled: true,
				},
				{ 'if-match': enabled.updated_at },
			),
			409,
			'CONFLICT',
		);
		const replaced = await expectOk<any>(
			await request(
				'PATCH',
				`/projects/${pid}/alert-destinations/${created.id}`,
				{ type: 'slack', webhook_url: 'https://hooks.example.com/services/replacement' },
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
		const idempotencyKey = 'retry-key-must-not-leak';
		const destination = await expectOk<any>(
			await local('POST', `/projects/${pid}/alert-destinations`, {
				name: 'Webhook',
				type: 'webhook',
				url: endpoint,
				signing_secret: secret,
			}),
			201,
		);

		const path = `/projects/${pid}/alert-destinations/${destination.id}/test`;
		await expectError(
			await local(
				'POST',
				path,
				undefined,
				alertTestHeaders(destination.updated_at, idempotencyKey),
			),
			503,
			'SERVICE_UNAVAILABLE',
		);
		await expectError(
			await local(
				'POST',
				path,
				undefined,
				alertTestHeaders(destination.updated_at, idempotencyKey),
			),
			409,
			'CONFLICT',
		);
		await expectError(
			await local(
				'POST',
				path,
				undefined,
				alertTestHeaders(destination.updated_at, 'new-key-after-failure'),
			),
			503,
			'SERVICE_UNAVAILABLE',
		);
		const testCalls = vi.mocked(failingDispatcher.test).mock.calls;
		expect(testCalls).toHaveLength(2);
		expect(testCalls[0]?.[3].dedupe_key).not.toBe(testCalls[1]?.[3].dedupe_key);
		expect(testCalls[0]?.[3].dedupe_key).not.toContain(idempotencyKey);
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
		expect(serialized).not.toContain(idempotencyKey);
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
					alertTestHeaders(destination.updated_at),
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
				alertTestHeaders(destination.updated_at),
			),
			429,
			'RESOURCE_EXHAUSTED',
		);
		expect(test).toHaveBeenCalledTimes(10);
	});
});
