import { describe, expect, it, vi } from 'vitest';
import type { IntegrationProbe } from '../../../ports/integrations';
import { createIntegrationId, createProjectId, createSessionId, UserId } from '../../../ids';
import { MemoryBucket } from '../../../testing/MemoryBucket';
import { AesGcmSecretCodec } from '../../secrets/AesGcmSecretCodec';
import { bundleIntegrations } from '../bundle';
import { OrgIntegrationsStore, ProjectIntegrationsStore } from '../ProjectIntegrationsStore';
import { defaultRegistry } from './index';
import { otlpLogs } from './logging';
import { OTLP_LOGS_AUTH_SAMPLES } from './sampleConfigs';

const actor = UserId.parse('logging-test');
const projectId = createProjectId();
const context = {
	instanceName: 'logs',
	projectId,
	workload: { kind: 'session' as const, id: createSessionId() },
	principal: { userId: actor, email: 'test@example.com' },
};

describe('logging integrations', () => {
	const methods = Object.keys(OTLP_LOGS_AUTH_SAMPLES) as (keyof typeof OTLP_LOGS_AUTH_SAMPLES)[];
	const parse = (config: unknown) => otlpLogs.configSchema.parse(config);
	const withHeaders = (headers: unknown, url = 'https://example.test/v1/logs') => ({
		url,
		auth: { method: 'headers', headers },
	});

	describe.each(methods)('auth.method %s connectivity', (method) => {
		const config = parse(OTLP_LOGS_AUTH_SAMPLES[method]);
		const destination = otlpLogs.render({ ...context, config }).logging![0];
		const probe = (status: number): IntegrationProbe => ({
			fetch: vi.fn().mockResolvedValue({
				ok: status >= 200 && status < 300,
				status,
				json: async () => ({ error: 'private-response' }),
			}),
			connect: vi.fn(),
		});

		it.each([200, 204])('posts no log records and accepts HTTP %s', async (status) => {
			const transport = probe(status);
			const signal = new AbortController().signal;
			const result = await otlpLogs.testConnection!(config, transport, { signal });
			expect(result).toMatchObject({ ok: true, latency_ms: expect.any(Number) });
			expect(result.details).toContain('no log records were sent');
			expect(result.details).not.toContain('private-response');
			expect(transport.fetch).toHaveBeenCalledExactlyOnceWith(destination.url, {
				method: 'POST',
				headers: { ...destination.headers, 'Content-Type': 'application/json' },
				body: '{"resourceLogs":[]}',
				signal,
			});
		});

		it.each([301, 401, 403, 404, 429, 500])(
			'reports HTTP %s without response text',
			async (status) => {
				expect(await otlpLogs.testConnection!(config, probe(status))).toMatchObject({
					ok: false,
					details: `HTTP ${status}`,
				});
			},
		);

		it('sanitizes transport errors', async () => {
			const transport = probe(200);
			vi.mocked(transport.fetch).mockRejectedValue(new Error('private transport credentials'));
			expect(await otlpLogs.testConnection!(config, transport)).toMatchObject({
				ok: false,
				details: 'request failed',
			});
		});
	});

	it.each([
		{ url: 'https://user:secret@example.test/v1/logs' },
		{ auth: { method: 'headers' as const, headers: [{ name: 'Host', value: 'secret' }] } },
		{
			auth: {
				method: 'headers' as const,
				headers: [{ name: 'Authorization', value: 'secret\r\nInjected: true' }],
			},
		},
		{ auth: { method: 'bearer' as const, token: 'secret\r\nInjected: true' } },
	])('validates probe URL and resolved headers before network access: %j', async (overrides) => {
		const config = { ...parse(OTLP_LOGS_AUTH_SAMPLES.headers), ...overrides };
		const probe: IntegrationProbe = { fetch: vi.fn(), connect: vi.fn() };
		await expect(otlpLogs.testConnection!(config, probe)).rejects.toThrow(/Invalid OTLP/);
		expect(probe.fetch).not.toHaveBeenCalled();
	});

	it('bundles destinations without changing notebook packages or exposing credentials in the manifest', () => {
		const result = bundleIntegrations(
			methods.map((method) => {
				const name = `logs-${method}`;
				return {
					id: createIntegrationId(),
					name,
					kind: 'otlp_logs',
					version: 1,
					output: otlpLogs.render({
						...context,
						instanceName: name,
						config: parse(OTLP_LOGS_AUTH_SAMPLES[method]),
					}),
				};
			}),
			context.workload,
		);
		expect(result.runtimePackages).toBeUndefined();
		expect(result.logging?.[0]).toMatchObject({
			level: 'INFO',
			serviceName: 'marimohub-notebook',
			attributes: {
				'marimohub.project_id': projectId,
				'marimohub.workload_id': context.workload.id,
			},
		});
		expect(Object.fromEntries(result.logging!.map(({ name, headers }) => [name, headers]))).toEqual(
			{
				'logs-none': {},
				'logs-bearer': { Authorization: 'Bearer bearer-token' },
				'logs-basic': { Authorization: `Basic ${btoa('123:basic-token')}` },
				'logs-headers': { Authorization: 'Bearer otlp-token' },
			},
		);
		const manifest = result.files.find((file) => file.path.endsWith('/manifest.json'))!.content;
		for (const secret of ['bearer-token', 'basic-token', 'otlp-token'])
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
		{ auth: null },
		{ auth: { method: 'oauth2' } },
		{ auth: { method: 'none', token: 'stray' } },
		{ auth: { method: 'bearer' } },
		{ auth: { method: 'bearer', token: '' } },
		{ auth: { method: 'basic', password: 'secret' } },
		{ auth: { method: 'basic', username: 'a:b', password: 'secret' } },
		{ auth: { method: 'basic', username: 'a b', password: 'secret' } },
		{ auth: { method: 'basic', username: 'a' } },
		{ headers: [{ name: 'Authorization', value: 'token' }] },
		withHeaders(null),
		withHeaders([]),
		{ auth: { method: 'headers' } },
		withHeaders([{ name: '', value: 'token' }]),
		withHeaders([{ name: 'X-Key\r\nInjected', value: 'token' }]),
		withHeaders(
			Array.from({ length: 33 }, (_, index) => ({ name: `X-Key-${index}`, value: 'token' })),
		),
		{ typo: true },
		withHeaders([
			{ name: 'Authorization', value: 'a' },
			{ name: 'authorization', value: 'b' },
		]),
	])('rejects invalid settings: %j', (overrides) => {
		expect(
			otlpLogs.configSchema.safeParse({ url: 'https://example.test/v1/logs', ...overrides })
				.success,
		).toBe(false);
	});

	it.each(['private\r\ninjected: value', 'private\0value', 'private\tvalue', 'privateé'])(
		'rejects invalid resolved header values without echoing the secret',
		(value) => {
			const config = parse(withHeaders([{ name: 'Authorization', value }]));
			expect(() => otlpLogs.render({ ...context, config })).toThrow(
				'Invalid OTLP authentication header.',
			);
		},
	);
	it.each(['Host', 'Content-Length', 'Content-Type', 'Transfer-Encoding', 'Connection'])(
		'rejects reserved HTTP header %s',
		(name) => {
			const config = parse(withHeaders([{ name, value: 'secret' }]));
			expect(() => otlpLogs.render({ ...context, config })).toThrow(
				'Invalid OTLP authentication header.',
			);
		},
	);
	it('rejects a reserved header name when an org integration is saved', async () => {
		const org = new OrgIntegrationsStore({
			bucket: new MemoryBucket(),
			registry: defaultRegistry(),
			codec: new AesGcmSecretCodec({ kek: 'sFjp5R6eWYvc9SGtfeYEsQQlMKB8MfP4FdFAD7JAjsw=' }),
		});
		await expect(
			org.create(
				{
					kind: 'otlp_logs',
					name: 'logs',
					config: withHeaders([{ name: 'content-TYPE', value: 'text/plain' }]),
				},
				actor,
			),
		).rejects.toThrow('HTTP header "content-TYPE" is reserved.');
		expect(await org.list()).toEqual([]);
	});

	it.each(['Host', 'Content-Length', 'Content-Type', 'Transfer-Encoding', 'Connection'])(
		'rejects reserved HTTP header %s at save time',
		(name) => {
			const config = parse(withHeaders([{ name, value: 'secret' }]));
			expect(() => otlpLogs.validate!(config)).toThrow(`HTTP header "${name}" is reserved.`);
		},
	);

	it.each(methods.filter((method) => method !== 'none'))(
		'requires HTTPS for auth.method %s',
		(method) => {
			const config = parse({
				...OTLP_LOGS_AUTH_SAMPLES[method],
				url: 'http://collector.internal:4318/v1/logs',
			});
			expect(() => otlpLogs.validate!(config)).toThrow(
				'Log export with credentials requires HTTPS.',
			);
		},
	);

	it('allows plain HTTP without credentials', () => {
		const config = parse(OTLP_LOGS_AUTH_SAMPLES.none);
		expect(config.auth).toEqual({ method: 'none' });
		expect(() => otlpLogs.validate!(config)).not.toThrow();
	});

	it('marks every credential as a secret', () => {
		expect(defaultRegistry().secretPathsOf('otlp_logs')).toEqual([
			['auth', 'token'],
			['auth', 'password'],
			['auth', 'headers', '*', 'value'],
		]);
	});

	it('validates bearer tokens after secret resolution and encodes basic credentials', () => {
		expect(() =>
			otlpLogs.render({
				...context,
				config: parse({
					url: 'https://example.test/v1/logs',
					auth: { method: 'bearer', token: 'secret\nvalue' },
				}),
			}),
		).toThrow('Invalid OTLP authentication header.');
		const result = otlpLogs.render({
			...context,
			config: parse({
				url: 'https://example.test/v1/logs',
				auth: { method: 'basic', username: '123', password: 'p@ss:word' },
			}),
		});
		expect(result.logging?.[0].headers.Authorization).toBe(`Basic ${btoa('123:p@ss:word')}`);
	});

	it('does not keep a secret from a different auth method', async () => {
		const project = new ProjectIntegrationsStore({
			bucket: new MemoryBucket(),
			registry: defaultRegistry(),
			codec: new AesGcmSecretCodec({ kek: 'sFjp5R6eWYvc9SGtfeYEsQQlMKB8MfP4FdFAD7JAjsw=' }),
		});
		const entry = await project.create(
			projectId,
			{ kind: 'otlp_logs', name: 'logs', config: OTLP_LOGS_AUTH_SAMPLES.bearer },
			actor,
		);
		await expect(
			project.update(
				projectId,
				entry.id,
				{
					config: {
						url: OTLP_LOGS_AUTH_SAMPLES.bearer.url,
						auth: { method: 'basic', username: '123', password: { $secret: { set: true } } },
					},
				},
				actor,
			),
		).rejects.toThrow('has no stored encrypted value to keep');
		expect((await project.resolveForSession(projectId, context))?.logging?.[0].headers).toEqual({
			Authorization: 'Bearer bearer-token',
		});
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
				config: withHeaders(
					[
						{ name: 'Authorization', value: 'secret-a' },
						{ name: 'X-Api-Key', value: 'secret-b' },
					],
					url,
				),
			},
			actor,
		);
		await expect(
			project.update(
				projectId,
				entry.id,
				{
					config: withHeaders([{ name: 'Renamed-Header', value: { $secret: { set: true } } }], url),
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
			{ config: withHeaders([{ name: 'X-Api-Key', value: { $secret: { set: true } } }], url) },
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
				config: withHeaders([
					{ name: 'Authorization', value: 'secret-a' },
					{ name: 'X-Api-Key', value: 'secret-b' },
				]),
			},
			actor,
		);
		expect(JSON.stringify(local)).not.toContain('secret-a');
		await project.update(
			projectId,
			local.id,
			{
				config: withHeaders([
					{ name: 'X-Api-Key', value: { $secret: { set: true } } },
					{ name: 'Authorization', value: { $secret: { set: true } } },
				]),
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
