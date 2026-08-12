import { describe, expect, it } from 'vitest';
import {
	ConflictError,
	NotFoundError,
	PreconditionFailedError,
	ResourceExhaustedError,
	ValidationError,
} from '../../errors';
import { AesGcmSecretCodec } from '../secrets/AesGcmSecretCodec';
import { createAlertDestinationId, createProjectId } from '../../ids';
import { paths } from '../../paths';
import { ACTOR, MemoryBucket } from '../../testing';
import { MAX_PROJECT_ALERT_DESTINATIONS, ProjectAlertStore } from './ProjectAlertStore';

const KEK = '00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100';

function setup() {
	const bucket = new MemoryBucket();
	return {
		bucket,
		projectId: createProjectId(),
		store: new ProjectAlertStore(bucket, new AesGcmSecretCodec({ kek: KEK })),
	};
}

describe('ProjectAlertStore', () => {
	it('encrypts endpoint material and returns only redacted configuration', async () => {
		const { bucket, projectId, store } = setup();
		const destination = await store.create(
			projectId,
			{
				name: 'Deploy hook',
				type: 'webhook',
				url: 'https://alerts.example.test/hooks/secret-path',
				signing_secret: 'super-secret-signing-key',
			},
			ACTOR,
		);

		expect(destination).toMatchObject({
			type: 'webhook',
			endpoint_host: 'alerts.example.test',
			url_set: true,
			signing_secret_set: true,
			enabled: false,
			verified_at: null,
		});
		expect(destination).not.toHaveProperty('url');
		expect(destination).not.toHaveProperty('signing_secret');
		const stored = await bucket.get(paths.project(projectId).alerts);
		const plaintext = await stored?.text();
		expect(plaintext).not.toContain('secret-path');
		expect(plaintext).not.toContain('super-secret-signing-key');
	});

	it('preserves verification for metadata edits and invalidates it for endpoint edits', async () => {
		const { projectId, store } = setup();
		const created = await store.create(
			projectId,
			{
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/one',
			},
			ACTOR,
		);
		await expect(
			store.update(projectId, created.id, { enabled: true }, created.updated_at),
		).rejects.toBeInstanceOf(ConflictError);

		const verified = await store.markVerified(projectId, created.id, created.updated_at);
		const renamed = await store.update(
			projectId,
			created.id,
			{ name: 'Important Slack', kinds: ['project.deleted'] },
			verified.updated_at,
		);
		expect(renamed.verified_at).toBe(verified.verified_at);
		const enabled = await store.update(
			projectId,
			created.id,
			{ enabled: true },
			renamed.updated_at,
		);
		expect(enabled.enabled).toBe(true);

		const replaced = await store.update(
			projectId,
			created.id,
			{ webhook_url: 'https://hooks.slack.com/services/two', enabled: true },
			enabled.updated_at,
		);
		expect(replaced).toMatchObject({ enabled: false, verified_at: null });
	});

	it('does not verify a destination changed while its test was running', async () => {
		const { projectId, store } = setup();
		const created = await store.create(
			projectId,
			{
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/one',
			},
			ACTOR,
		);
		await store.update(projectId, created.id, { name: 'Changed' }, created.updated_at);

		await expect(
			store.markVerified(projectId, created.id, created.updated_at),
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('filters resolved destinations by enabled, verified, and event kind', async () => {
		const { projectId, store } = setup();
		const created = await store.create(
			projectId,
			{
				name: 'Slack',
				type: 'slack',
				kinds: ['project.deleted'],
				webhook_url: 'https://hooks.slack.com/services/one',
			},
			ACTOR,
		);
		const verified = await store.markVerified(projectId, created.id, created.updated_at);
		await store.update(projectId, created.id, { enabled: true }, verified.updated_at);

		expect(
			await store.resolve(projectId, { kind: 'project.deleted', requireEnabled: true }),
		).toHaveLength(1);
		expect(
			await store.resolve(projectId, { kind: 'notebook.deleted', requireEnabled: true }),
		).toEqual([]);
	});

	it('enforces the per-project destination limit', async () => {
		const { projectId, store } = setup();
		for (let index = 0; index < MAX_PROJECT_ALERT_DESTINATIONS; index++) {
			await store.create(
				projectId,
				{
					name: `Slack ${index}`,
					type: 'slack',
					webhook_url: `https://hooks.slack.com/services/${index}`,
				},
				ACTOR,
			);
		}
		await expect(
			store.create(
				projectId,
				{
					name: 'One too many',
					type: 'slack',
					webhook_url: 'https://hooks.slack.com/services/overflow',
				},
				ACTOR,
			),
		).rejects.toBeInstanceOf(ResourceExhaustedError);
	});

	it.each([
		['plain HTTP', 'http://hooks.example.com/alert'],
		['embedded username', 'https://user@hooks.example.com/alert'],
		['embedded password', 'https://user:secret@hooks.example.com/alert'],
	] as const)('rejects %s endpoints without writing a record', async (_label, webhookUrl) => {
		const { bucket, projectId, store } = setup();
		await expect(
			store.create(projectId, { name: 'Unsafe', type: 'slack', webhook_url: webhookUrl }, ACTOR),
		).rejects.toBeInstanceOf(ValidationError);
		expect(await bucket.get(paths.project(projectId).alerts)).toBeNull();
	});

	it('rejects empty names, empty event selections, and oversized stored fields', async () => {
		const { bucket, projectId, store } = setup();
		await expect(
			store.create(
				projectId,
				{ name: '  ', type: 'slack', webhook_url: 'https://hooks.example.com/one' },
				ACTOR,
			),
		).rejects.toBeInstanceOf(ValidationError);
		await expect(
			store.create(
				projectId,
				{
					name: 'No events',
					type: 'slack',
					kinds: [],
					webhook_url: 'https://hooks.example.com/two',
				},
				ACTOR,
			),
		).rejects.toBeInstanceOf(ValidationError);
		await expect(
			store.create(
				projectId,
				{
					name: 'x'.repeat(101),
					type: 'slack',
					webhook_url: 'https://hooks.example.com/three',
				},
				ACTOR,
			),
		).rejects.toThrow();
		expect(await bucket.get(paths.project(projectId).alerts)).toBeNull();
	});

	it('rejects fields belonging to another destination type', async () => {
		const { projectId, store } = setup();
		const slack = await store.create(
			projectId,
			{
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/one',
			},
			ACTOR,
		);
		await expect(
			store.update(projectId, slack.id, { url: 'https://events.example.com/hook' }),
		).rejects.toBeInstanceOf(ValidationError);

		const webhook = await store.create(
			projectId,
			{
				name: 'Webhook',
				type: 'webhook',
				url: 'https://events.example.com/hook',
				signing_secret: 'secret',
			},
			ACTOR,
		);
		await expect(
			store.update(projectId, webhook.id, {
				webhook_url: 'https://hooks.slack.com/services/two',
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});

	it('rejects stale updates and deletes without changing the destination', async () => {
		const { projectId, store } = setup();
		const created = await store.create(
			projectId,
			{
				name: 'Slack',
				type: 'slack',
				webhook_url: 'https://hooks.slack.com/services/one',
			},
			ACTOR,
		);
		const updated = await store.update(
			projectId,
			created.id,
			{ name: 'Current' },
			created.updated_at,
		);

		await expect(
			store.update(projectId, created.id, { name: 'Stale' }, created.updated_at),
		).rejects.toBeInstanceOf(PreconditionFailedError);
		await expect(store.remove(projectId, created.id, created.updated_at)).rejects.toBeInstanceOf(
			PreconditionFailedError,
		);
		expect(await store.list(projectId)).toEqual([updated]);
	});

	it('returns not found for unknown update, delete, and verification targets', async () => {
		const { projectId, store } = setup();
		const id = createAlertDestinationId();
		await expect(store.update(projectId, id, { name: 'Missing' })).rejects.toBeInstanceOf(
			NotFoundError,
		);
		await expect(store.remove(projectId, id)).rejects.toBeInstanceOf(NotFoundError);
		await expect(
			store.markVerified(projectId, id, new Date().toISOString()),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it('fails closed when encrypted material is opened with the wrong KEK', async () => {
		const { bucket, projectId, store } = setup();
		await store.create(
			projectId,
			{
				name: 'Webhook',
				type: 'webhook',
				url: 'https://events.example.com/hook',
				signing_secret: 'signing-secret',
			},
			ACTOR,
		);
		const wrongStore = new ProjectAlertStore(
			bucket,
			new AesGcmSecretCodec({
				kek: 'ffeeddccbbaa9988776655443322110000112233445566778899aabbccddeeff',
			}),
		);
		await expect(wrongStore.resolve(projectId)).rejects.toThrow();
	});

	it('uses CAS to admit exactly ten destinations during a concurrent limit race', async () => {
		const { projectId, store } = setup();
		const results = await Promise.allSettled(
			Array.from({ length: MAX_PROJECT_ALERT_DESTINATIONS + 1 }, (_, index) =>
				store.create(
					projectId,
					{
						name: `Concurrent ${index}`,
						type: 'slack',
						webhook_url: `https://hooks.slack.com/services/concurrent-${index}`,
					},
					ACTOR,
				),
			),
		);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
		const [rejected] = results.filter((result) => result.status === 'rejected');
		expect(rejected).toMatchObject({ reason: expect.any(ResourceExhaustedError) });
		expect(await store.list(projectId)).toHaveLength(10);
	});
});
