import { describe, expect, it, vi } from 'vitest';
import {
	AesGcmSecretCodec,
	createProjectId,
	createSlidingWindowBudget,
	noopMetrics,
	paths,
	ProjectAlertStore,
} from '@marimo-hub/core';
import type { IntegrationProbe, Metrics, ProjectAlertKind, ProjectId } from '@marimo-hub/core';
import { ACTOR, BROADCAST_NOTIFICATION_FIXTURE, MemoryBucket } from '@marimo-hub/core/testing';
import { ConfigError } from './errors';
import {
	makeProjectAlerts,
	NodeProjectAlertDispatcher,
	projectAlertsEnabled,
} from './projectAlerts';

const KEK = '00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100';

describe('project alert configuration', () => {
	it('is off by default and accepts the documented switches', () => {
		expect(projectAlertsEnabled({})).toBe(false);
		expect(projectAlertsEnabled({ MARIMOHUB_PROJECT_ALERTS: 'off' })).toBe(false);
		expect(projectAlertsEnabled({ MARIMOHUB_PROJECT_ALERTS: 'on' })).toBe(true);
		expect(() => projectAlertsEnabled({ MARIMOHUB_PROJECT_ALERTS: 'maybe' })).toThrow(ConfigError);
	});

	it('fails startup when enabled without a managed-secret KEK', () => {
		expect(() => makeProjectAlerts({ MARIMOHUB_PROJECT_ALERTS: 'on' }, new MemoryBucket())).toThrow(
			/MARIMOHUB_SECRETS_KEK/,
		);
	});

	it('builds the bounded store and dispatcher with a valid KEK', () => {
		const alerts = makeProjectAlerts(
			{ MARIMOHUB_PROJECT_ALERTS: 'on', MARIMOHUB_SECRETS_KEK: KEK },
			new MemoryBucket(),
		);
		expect(alerts).toMatchObject({ maxDestinations: 10 });
		expect(alerts?.store).toBeDefined();
		expect(alerts?.dispatcher).toBeDefined();
	});

	it('does not initialize integration secret resolvers', () => {
		const alerts = makeProjectAlerts(
			{
				MARIMOHUB_PROJECT_ALERTS: 'on',
				MARIMOHUB_SECRETS_KEK: KEK,
				MARIMOHUB_SECRETS_KUBERNETES: 'true',
				MARIMOHUB_SECRETS_KUBERNETES_ALLOWED_SECRETS: 'not-json',
			},
			new MemoryBucket(),
		);
		expect(alerts).toBeDefined();
	});

	it('fails startup with an invalid managed-secret KEK', () => {
		expect(() =>
			makeProjectAlerts(
				{ MARIMOHUB_PROJECT_ALERTS: 'on', MARIMOHUB_SECRETS_KEK: 'too-short' },
				new MemoryBucket(),
			),
		).toThrow(ConfigError);
	});
});

function probe(fetch: IntegrationProbe['fetch']): IntegrationProbe {
	return { fetch, connect: () => Promise.reject(new Error('unused')) };
}

async function enabledDestination(
	store: ProjectAlertStore,
	projectId: ProjectId,
	input:
		| { type: 'slack'; name: string; webhook_url: string }
		| { type: 'webhook'; name: string; url: string; signing_secret: string },
) {
	const created = await store.create(projectId, { ...input, kinds: ['session.takeover'] }, ACTOR);
	const verified = await store.markVerified(projectId, created.id, created.updated_at);
	return store.update(projectId, created.id, { enabled: true }, verified.updated_at);
}

describe('NodeProjectAlertDispatcher', () => {
	it('skips when no enabled verified destination selects the kind', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const projectId = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		await store.create(
			projectId,
			{
				name: 'Disabled',
				type: 'slack',
				kinds: ['session.takeover'],
				webhook_url: 'https://hooks.example.com/disabled',
			},
			ACTOR,
		);
		const increment = vi.fn();
		const fetch = vi.fn();
		const dispatcher = new NodeProjectAlertDispatcher(
			store,
			{ increment, gauge: vi.fn() },
			probe(fetch),
		);

		await expect(
			dispatcher.deliver(projectId, 'session.takeover', BROADCAST_NOTIFICATION_FIXTURE),
		).resolves.toBe('skipped');
		expect(fetch).not.toHaveBeenCalled();
		expect(increment).toHaveBeenCalledWith('project_alert.skipped', 1, {
			kind: 'session.takeover',
		});
	});

	it('rejects a mismatched kind or personal notification before loading destinations', async () => {
		const store = new ProjectAlertStore(new MemoryBucket(), new AesGcmSecretCodec({ kek: KEK }));
		const dispatcher = new NodeProjectAlertDispatcher(store, noopMetrics, probe(vi.fn()));
		await expect(
			dispatcher.deliver(
				BROADCAST_NOTIFICATION_FIXTURE.data.project_id,
				'project.deleted',
				BROADCAST_NOTIFICATION_FIXTURE,
			),
		).rejects.toThrow(/matching broadcast/);
		await expect(
			dispatcher.deliver(BROADCAST_NOTIFICATION_FIXTURE.data.project_id, 'session.takeover', {
				...BROADCAST_NOTIFICATION_FIXTURE,
				audience: 'personal',
			} as never),
		).rejects.toThrow(/matching broadcast/);
	});

	it('retries a signed webhook once and preserves the signed envelope', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const projectId = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		await enabledDestination(store, projectId, {
			name: 'Webhook',
			type: 'webhook',
			url: 'https://events.example.com/project-alerts',
			signing_secret: 'signing-secret',
		});
		const fetch = vi
			.fn<IntegrationProbe['fetch']>()
			.mockRejectedValueOnce(new Error('temporary failure'))
			.mockResolvedValue({ ok: true, status: 204, json: async () => null });
		const dispatcher = new NodeProjectAlertDispatcher(store, noopMetrics, probe(fetch));

		await expect(
			dispatcher.deliver(projectId, 'session.takeover', BROADCAST_NOTIFICATION_FIXTURE),
		).resolves.toBe('delivered');
		expect(fetch).toHaveBeenCalledTimes(2);
		const [, options] = fetch.mock.calls[1];
		expect(options?.headers?.['X-Marimohub-Signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
		expect(JSON.parse(options?.body ?? '')).toEqual(BROADCAST_NOTIFICATION_FIXTURE);
	});

	it('does not retry a signed webhook after a permanent HTTP response', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const projectId = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		await enabledDestination(store, projectId, {
			name: 'Webhook',
			type: 'webhook',
			url: 'https://events.example.com/project-alerts',
			signing_secret: 'signing-secret',
		});
		const fetch = vi.fn<IntegrationProbe['fetch']>(async () => ({
			ok: false,
			status: 401,
			json: async () => null,
		}));
		const dispatcher = new NodeProjectAlertDispatcher(store, noopMetrics, probe(fetch));

		await expect(
			dispatcher.deliver(projectId, 'session.takeover', BROADCAST_NOTIFICATION_FIXTURE),
		).rejects.toThrow();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('retries a signed webhook after a retryable HTTP response', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const projectId = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		await enabledDestination(store, projectId, {
			name: 'Webhook',
			type: 'webhook',
			url: 'https://events.example.com/project-alerts',
			signing_secret: 'signing-secret',
		});
		const fetch = vi
			.fn<IntegrationProbe['fetch']>()
			.mockResolvedValueOnce({
				ok: false,
				status: 429,
				headers: { 'retry-after': '999999' },
				json: async () => null,
			})
			.mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });
		const delay = vi.fn(async () => {});
		const dispatcher = new NodeProjectAlertDispatcher(
			store,
			noopMetrics,
			probe(fetch),
			undefined,
			delay,
		);

		await expect(
			dispatcher.deliver(projectId, 'session.takeover', BROADCAST_NOTIFICATION_FIXTURE),
		).resolves.toBe('delivered');
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(delay).toHaveBeenCalledWith(60_000);
	});

	it('isolates a failed destination and reports partial fan-out', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const projectId = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		await enabledDestination(store, projectId, {
			name: 'Broken Slack',
			type: 'slack',
			webhook_url: 'https://hooks.example.com/broken',
		});
		await enabledDestination(store, projectId, {
			name: 'Healthy Slack',
			type: 'slack',
			webhook_url: 'https://hooks.example.com/healthy',
		});
		const fetch = vi.fn<IntegrationProbe['fetch']>(async (url) => {
			if (url.endsWith('/broken')) throw new Error('offline');
			return { ok: true, status: 200, json: async () => null };
		});
		const increment = vi.fn();
		const metrics: Metrics = { increment, gauge: vi.fn() };
		const dispatcher = new NodeProjectAlertDispatcher(store, metrics, probe(fetch));

		await expect(
			dispatcher.deliver(projectId, 'session.takeover', BROADCAST_NOTIFICATION_FIXTURE),
		).resolves.toBe('partial');
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(increment).toHaveBeenCalledWith('project_alert.deliver_failed', 1, {
			adapter: 'slack',
			kind: 'session.takeover',
		});
		expect(increment).toHaveBeenCalledWith('project_alert.delivered', 1, {
			adapter: 'slack',
			kind: 'session.takeover',
		});
	});

	it('isolates destination decryption failures during fan-out', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const projectId = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		const broken = await enabledDestination(store, projectId, {
			name: 'Broken Slack',
			type: 'slack',
			webhook_url: 'https://hooks.example.com/broken',
		});
		await enabledDestination(store, projectId, {
			name: 'Healthy Slack',
			type: 'slack',
			webhook_url: 'https://hooks.example.com/healthy',
		});
		const key = paths.project(projectId).alerts;
		const object = await bucket.get(key);
		const config = JSON.parse((await object?.text()) ?? '{}') as {
			destinations: { id: string; webhook_url?: { ciphertext: string } }[];
		};
		const stored = config.destinations.find((destination) => destination.id === broken.id);
		if (!stored?.webhook_url) throw new Error('Expected stored Slack destination');
		stored.webhook_url.ciphertext = 'AAAA';
		await bucket.put(key, JSON.stringify(config));
		const fetch = vi.fn<IntegrationProbe['fetch']>(async () => ({
			ok: true,
			status: 200,
			json: async () => null,
		}));
		const dispatcher = new NodeProjectAlertDispatcher(store, noopMetrics, probe(fetch));

		await expect(
			dispatcher.deliver(projectId, 'session.takeover', BROADCAST_NOTIFICATION_FIXTURE),
		).resolves.toBe('partial');
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]?.[0]).toBe('https://hooks.example.com/healthy');
	});

	it('limits noisy projects without consuming another project budget', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const firstProject = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		const secondProject = createProjectId();
		await enabledDestination(store, firstProject, {
			name: 'First Slack',
			type: 'slack',
			webhook_url: 'https://hooks.example.com/first',
		});
		await enabledDestination(store, secondProject, {
			name: 'Second Slack',
			type: 'slack',
			webhook_url: 'https://hooks.example.com/second',
		});
		const fetch = vi.fn<IntegrationProbe['fetch']>(async () => ({
			ok: true,
			status: 200,
			json: async () => null,
		}));
		const dispatcher = new NodeProjectAlertDispatcher(
			store,
			noopMetrics,
			probe(fetch),
			createSlidingWindowBudget({ limit: 1, windowMs: 60_000 }),
		);
		await expect(
			dispatcher.deliver(firstProject, 'session.takeover', BROADCAST_NOTIFICATION_FIXTURE),
		).resolves.toBe('delivered');
		await expect(
			dispatcher.deliver(firstProject, 'session.takeover', BROADCAST_NOTIFICATION_FIXTURE),
		).resolves.toBe('skipped');
		await expect(
			dispatcher.deliver(secondProject, 'session.takeover', BROADCAST_NOTIFICATION_FIXTURE),
		).resolves.toBe('delivered');
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('records a skipped event when a destination changes during fan-out', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const projectId = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		await enabledDestination(store, projectId, {
			name: 'Slack',
			type: 'slack',
			webhook_url: 'https://hooks.example.com/raced',
		});
		vi.spyOn(store, 'resolve').mockResolvedValue([]);
		const increment = vi.fn();
		const fetch = vi.fn<IntegrationProbe['fetch']>();
		const dispatcher = new NodeProjectAlertDispatcher(
			store,
			{ increment, gauge: vi.fn() },
			probe(fetch),
		);

		await expect(
			dispatcher.deliver(projectId, 'session.takeover', BROADCAST_NOTIFICATION_FIXTURE),
		).resolves.toBe('skipped');
		expect(fetch).not.toHaveBeenCalled();
		expect(increment).toHaveBeenCalledWith('project_alert.skipped', 1, {
			kind: 'session.takeover',
		});
	});

	it('fails a test without verifying the destination or exposing the transport error', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const projectId = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		const created = await store.create(
			projectId,
			{
				name: 'Broken',
				type: 'slack',
				kinds: ['session.takeover'],
				webhook_url: 'https://hooks.example.com/private-path',
			},
			ACTOR,
		);
		const dispatcher = new NodeProjectAlertDispatcher(
			store,
			noopMetrics,
			probe(
				vi.fn(async () => {
					throw new Error('https://hooks.example.com/private-path failed');
				}),
			),
		);

		await expect(
			dispatcher.test(projectId, created.id, created.updated_at, BROADCAST_NOTIFICATION_FIXTURE),
		).rejects.toThrow('Alert destination test failed');
		expect((await store.list(projectId))[0]?.verified_at).toBeNull();
	});

	it('tests without a precondition and verifies the delivered snapshot', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const projectId = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		const created = await store.create(
			projectId,
			{
				name: 'Slack',
				type: 'slack',
				kinds: ['session.takeover'],
				webhook_url: 'https://hooks.example.com/test',
			},
			ACTOR,
		);
		const fetch = vi.fn<IntegrationProbe['fetch']>(async () => ({
			ok: true,
			status: 200,
			json: async () => null,
		}));
		const dispatcher = new NodeProjectAlertDispatcher(store, noopMetrics, probe(fetch));

		const verified = await dispatcher.test(
			projectId,
			created.id,
			undefined,
			BROADCAST_NOTIFICATION_FIXTURE,
		);
		expect(fetch).toHaveBeenCalledOnce();
		expect(verified.verified_at).not.toBeNull();
	});

	it('rejects a stale precondition before sending the test alert', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const projectId = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		const created = await store.create(
			projectId,
			{
				name: 'Slack',
				type: 'slack',
				kinds: ['session.takeover'],
				webhook_url: 'https://hooks.example.com/test',
			},
			ACTOR,
		);
		await store.update(projectId, created.id, { name: 'Renamed' }, created.updated_at);
		const fetch = vi.fn<IntegrationProbe['fetch']>();
		const dispatcher = new NodeProjectAlertDispatcher(store, noopMetrics, probe(fetch));

		await expect(
			dispatcher.test(projectId, created.id, created.updated_at, BROADCAST_NOTIFICATION_FIXTURE),
		).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', status: 412 });
		expect(fetch).not.toHaveBeenCalled();
		expect((await store.list(projectId))[0]?.verified_at).toBeNull();
	});

	it('reports a sanitized adapter error when the only destination fails', async () => {
		const bucket = new MemoryBucket();
		const store = new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK }));
		const projectId = BROADCAST_NOTIFICATION_FIXTURE.data.project_id;
		await enabledDestination(store, projectId, {
			name: 'Broken',
			type: 'slack',
			webhook_url: 'https://hooks.example.com/broken',
		});
		const dispatcher = new NodeProjectAlertDispatcher(
			store,
			noopMetrics,
			probe(
				vi.fn(async () => {
					throw new Error('offline');
				}),
			),
		);

		await expect(
			dispatcher.deliver(
				projectId,
				'session.takeover' satisfies ProjectAlertKind,
				BROADCAST_NOTIFICATION_FIXTURE,
			),
		).rejects.toThrow('Slack notification delivery failed');
	});
});
