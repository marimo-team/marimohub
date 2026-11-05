import { describe, expect, it } from 'vitest';
import { createIntegrationId, createProjectId, createSessionId, UserId } from '../../../ids';
import { MemoryBucket } from '../../../testing/MemoryBucket';
import { AesGcmSecretCodec } from '../../secrets/AesGcmSecretCodec';
import { bundleIntegrations } from '../bundle';
import { OrgIntegrationsStore, ProjectIntegrationsStore } from '../ProjectIntegrationsStore';
import { defaultRegistry } from './index';
import { otlpLogs, grafanaCloudLogs, betterStackLogs } from './logging';
import { SAMPLE_CONFIGS } from './sampleConfigs';

const actor = UserId.parse('logging-test');
const projectId = createProjectId();
const context = {
	instanceName: 'logs',
	projectId,
	workload: { kind: 'session' as const, id: createSessionId() },
	principal: { userId: actor, email: 'test@example.com' },
};

describe('logging integrations', () => {
	it('bundles destinations without changing notebook packages or exposing credentials in the manifest', () => {
		const registry = defaultRegistry();
		const result = bundleIntegrations(
			['otlp_logs', 'grafana_cloud_logs', 'better_stack_logs'].map((kind, index) => {
				const def = registry.get(kind);
				const name = `logs-${index}`;
				return {
					id: createIntegrationId(),
					name,
					kind,
					version: 1,
					output: def.render({
						...context,
						instanceName: name,
						config: def.configSchema.parse(SAMPLE_CONFIGS[kind]),
					}),
				};
			}),
			context.workload,
		);
		expect(result.logging).toHaveLength(3);
		expect(result.runtimePackages).toBeUndefined();
		expect(result.logging?.[0]).toMatchObject({
			level: 'INFO',
			serviceName: 'marimohub-notebook',
			attributes: {
				'marimohub.project_id': projectId,
				'marimohub.workload_id': context.workload.id,
			},
		});
		expect(result.logging?.[1].headers.Authorization).toBe(`Basic ${btoa('123:grafana-token')}`);
		expect(result.logging?.[2].headers.Authorization).toBe('Bearer better-stack-token');
		const manifest = result.files.find((file) => file.path.endsWith('/manifest.json'))!.content;
		for (const secret of ['otlp-token', 'grafana-token', 'better-stack-token'])
			expect(manifest).not.toContain(secret);
		expect(Object.keys(result.vars)).not.toContain('PYTHONPATH');
	});

	it.each([
		{ url: 'file:///logs' },
		{ url: 'https://user:password@example.test/v1/logs' },
		{ url: 'https://example.test/v1/logs?token=secret' },
		{ url: 'https://example.test/#fragment' },
		{ url: 'https:///example.test/v1/logs' },
		{ url: 'https://example.test:0/v1/logs' },
		{ level: 'TRACE' },
		{ headers: null },
		{ headers: [{ name: '', value: 'token' }] },
		{ headers: [{ name: 'X-Key\r\nInjected', value: 'token' }] },
		{
			headers: Array.from({ length: 33 }, (_, index) => ({
				name: `X-Key-${index}`,
				value: 'token',
			})),
		},
		{ typo: true },
		{
			headers: [
				{ name: 'Authorization', value: 'a' },
				{ name: 'authorization', value: 'b' },
			],
		},
	])('rejects invalid settings: %j', (overrides) => {
		expect(
			otlpLogs.configSchema.safeParse({ url: 'https://example.test/v1/logs', ...overrides })
				.success,
		).toBe(false);
	});

	it.each(['private\r\ninjected: value', 'private\0value', 'private\tvalue', 'privateé'])(
		'rejects invalid resolved header values without echoing the secret',
		(value) => {
			const config = otlpLogs.configSchema.parse({
				url: 'https://example.test/v1/logs',
				headers: [{ name: 'Authorization', value }],
			});
			expect(() => otlpLogs.render({ ...context, config })).toThrow(
				'Invalid OTLP authentication header.',
			);
		},
	);
	it.each(['Host', 'Content-Length', 'Content-Type', 'Transfer-Encoding', 'Connection'])(
		'rejects reserved HTTP header %s',
		(name) => {
			const config = otlpLogs.configSchema.parse({
				url: 'https://example.test/v1/logs',
				headers: [{ name, value: 'secret' }],
			});
			expect(() => otlpLogs.render({ ...context, config })).toThrow(
				'Invalid OTLP authentication header.',
			);
		},
	);
	it('validates bearer tokens after secret resolution and encodes basic credentials', () => {
		expect(() =>
			betterStackLogs.render({
				...context,
				config: betterStackLogs.configSchema.parse({
					url: 'https://example.test/v1/logs',
					source_token: 'secret\nvalue',
				}),
			}),
		).toThrow('Invalid OTLP authentication header.');
		const result = grafanaCloudLogs.render({
			...context,
			config: grafanaCloudLogs.configSchema.parse({
				url: 'https://example.test/v1/logs',
				username: '123',
				token: 'p@ss:word',
			}),
		});
		expect(result.logging?.[0].headers.Authorization).toBe(`Basic ${btoa('123:p@ss:word')}`);
	});

	it('rejects renamed keep markers without changing stored headers, then removes deleted headers', async () => {
		const project = new ProjectIntegrationsStore({
			bucket: new MemoryBucket(),
			registry: defaultRegistry(),
			codec: new AesGcmSecretCodec({ kek: 'sFjp5R6eWYvc9SGtfeYEsQQlMKB8MfP4FdFAD7JAjsw=' }),
		});
		const url = 'https://example.test/v1/logs';
		const entry = await project.create(
			projectId,
			{
				kind: 'otlp_logs',
				name: 'logs',
				config: {
					url,
					headers: [
						{ name: 'Authorization', value: 'secret-a' },
						{ name: 'X-Api-Key', value: 'secret-b' },
					],
				},
			},
			actor,
		);
		await expect(
			project.update(
				projectId,
				entry.id,
				{
					config: { url, headers: [{ name: 'Renamed-Header', value: { $secret: { set: true } } }] },
				},
				actor,
			),
		).rejects.toThrow('has no stored encrypted value to keep');
		expect((await project.resolveForSession(projectId, context))?.logging?.[0].headers).toEqual({
			Authorization: 'secret-a',
			'X-Api-Key': 'secret-b',
		});
		await project.update(
			projectId,
			entry.id,
			{ config: { url, headers: [{ name: 'X-Api-Key', value: { $secret: { set: true } } }] } },
			actor,
		);
		expect((await project.resolveForSession(projectId, context))?.logging?.[0].headers).toEqual({
			'X-Api-Key': 'secret-b',
		});
	});

	it('encrypts and retains named headers through reorder, and supports org opt-out', async () => {
		const bucket = new MemoryBucket();
		const options = {
			bucket,
			registry: defaultRegistry(),
			codec: new AesGcmSecretCodec({ kek: 'sFjp5R6eWYvc9SGtfeYEsQQlMKB8MfP4FdFAD7JAjsw=' }),
		};
		const org = new OrgIntegrationsStore(options);
		const project = new ProjectIntegrationsStore(options);
		await org.create(
			{ kind: 'otlp_logs', name: 'logs', config: { url: 'https://example.test/v1/logs' } },
			actor,
		);
		expect((await project.resolveForSession(projectId, context))?.logging).toHaveLength(1);
		const local = await project.create(
			projectId,
			{
				kind: 'otlp_logs',
				name: 'logs',
				config: {
					url: 'https://example.test/v1/logs',
					headers: [
						{ name: 'Authorization', value: 'secret-a' },
						{ name: 'X-Api-Key', value: 'secret-b' },
					],
				},
			},
			actor,
		);
		expect(JSON.stringify(local)).not.toContain('secret-a');
		await project.update(
			projectId,
			local.id,
			{
				config: {
					url: 'https://example.test/v1/logs',
					headers: [
						{ name: 'X-Api-Key', value: { $secret: { set: true } } },
						{ name: 'Authorization', value: { $secret: { set: true } } },
					],
				},
			},
			actor,
		);
		expect((await project.resolveForSession(projectId, context))?.logging?.[0].headers).toEqual({
			Authorization: 'secret-a',
			'X-Api-Key': 'secret-b',
		});
		await project.update(projectId, local.id, { enabled: false }, actor);
		expect((await project.resolveForSession(projectId, context))?.logging).toBeUndefined();
		await project.delete(projectId, local.id);
		expect((await project.resolveForSession(projectId, context))?.logging).toHaveLength(1);
	});
});
