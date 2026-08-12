import { describe, expect, it } from 'vitest';
import type { IntegrationProbe, ProbeRequestInit } from '../../../ports/integrations';
import { trino } from './trino';

const browse = trino.browse!;
const config = (over: Record<string, unknown> = {}) =>
	trino.configSchema.parse({
		host: 'trino.example.com',
		auth: { method: 'basic', username: 'alice', password: 'secret' },
		...over,
	});

function queuedProbe(bodies: unknown[]) {
	const calls: { url: string; init?: ProbeRequestInit }[] = [];
	let index = 0;
	const probe: IntegrationProbe = {
		fetch: async (url, init) => {
			calls.push({ url, init });
			return { ok: true, status: 200, json: async () => bodies[index++] };
		},
	};
	return { probe, calls };
}

describe('trino browse', () => {
	it('supports hub-safe auth and blocks sandbox-only auth or TLS', () => {
		expect(browse.available(config())).toEqual({ ok: true });
		expect(browse.available(config({ auth: { method: 'oauth2' } }))).toMatchObject({ ok: false });
		expect(browse.available(config({ tls: { verification: 'disabled' } }))).toMatchObject({
			ok: false,
		});
	});

	it('uses the requesting principal when no integration user is configured', async () => {
		const { probe, calls } = queuedProbe([{ columns: [{ name: 'Catalog' }], data: [] }]);
		await browse.listNamespaces(config({ auth: { method: 'none' } }), probe, {
			limit: 10,
			query_user: 'alice@example.com',
		});
		expect(calls[0].init?.headers).toMatchObject({ 'X-Trino-User': 'alice@example.com' });
	});

	it('lists catalogs and follows same-coordinator statement pages', async () => {
		const { probe, calls } = queuedProbe([
			{
				id: 'q1',
				nextUri: 'https://trino.example.com:443/v1/statement/q1/1',
				columns: [{ name: 'Catalog' }],
				data: [['iceberg']],
			},
			{ id: 'q1', data: [['memory']] },
		]);

		await expect(browse.listNamespaces(config(), probe, { limit: 10 })).resolves.toEqual({
			items: [['iceberg'], ['memory']],
			next_cursor: null,
		});
		expect(calls[0]).toMatchObject({
			url: 'https://trino.example.com/v1/statement',
			init: { method: 'POST', body: 'SHOW CATALOGS' },
		});
		expect(calls[0].init?.headers).toMatchObject({
			Authorization: expect.stringMatching(/^Basic /),
			'X-Trino-User': 'alice',
		});
		expect(calls[1].url).toBe('https://trino.example.com/v1/statement/q1/1');
	});

	it('treats an empty parent as a root namespace request', async () => {
		const { probe, calls } = queuedProbe([{ columns: [{ name: 'Catalog' }], data: [['iceberg']] }]);

		await expect(
			browse.listNamespaces(config(), probe, { limit: 10, parent: [] }),
		).resolves.toEqual({
			items: [['iceberg']],
			next_cursor: null,
		});
		expect(calls[0].init?.body).toBe('SHOW CATALOGS');
	});

	it('uses stable name cursors when metadata changes between pages', async () => {
		const { probe } = queuedProbe([
			{ columns: [{ name: 'Catalog' }], data: [['alpha'], ['beta'], ['delta']] },
			{ columns: [{ name: 'Catalog' }], data: [['aardvark'], ['beta'], ['delta'], ['epsilon']] },
		]);
		const first = await browse.listNamespaces(config(), probe, { limit: 2 });
		expect(first).toEqual({ items: [['alpha'], ['beta']], next_cursor: 'name:beta' });

		await expect(
			browse.listNamespaces(config(), probe, { limit: 2, cursor: first.next_cursor! }),
		).resolves.toEqual({ items: [['delta'], ['epsilon']], next_cursor: null });
	});

	it('quotes identifiers for schema reads and bounded previews', async () => {
		const schemaProbe = queuedProbe([
			{
				columns: [{ name: 'Column' }, { name: 'Type' }, { name: 'Extra' }, { name: 'Comment' }],
				data: [['id', 'bigint', '', 'primary id']],
			},
		]);
		await expect(
			browse.getTableSchema(config(), schemaProbe.probe, ['ice"berg', 'sales'], 'ord"ers'),
		).resolves.toEqual({
			columns: [{ name: 'id', type: 'bigint', nullable: true, comment: 'primary id' }],
		});
		expect(schemaProbe.calls[0].init?.body).toBe('DESCRIBE "ice""berg"."sales"."ord""ers"');

		const previewProbe = queuedProbe([
			{ columns: [{ name: 'id' }, { name: 'name' }], data: [[1, 'Ada']] },
		]);
		await expect(
			browse.previewRows!(config(), previewProbe.probe, ['iceberg', 'sales'], 'orders', {
				limit: 5,
			}),
		).resolves.toEqual({ columns: ['id', 'name'], rows: [[1, 'Ada']] });
		expect(previewProbe.calls[0].init?.body).toBe(
			'SELECT * FROM "iceberg"."sales"."orders" LIMIT 5',
		);
	});

	it('rejects a continuation URL on another origin', async () => {
		const { probe } = queuedProbe([{ nextUri: 'https://attacker.example/v1/statement/q/1' }]);
		await expect(browse.listNamespaces(config(), probe, { limit: 10 })).rejects.toThrow(
			'invalid continuation URL',
		);
	});

	it('caps one statement operation at eight upstream requests', async () => {
		const { probe, calls } = queuedProbe([
			{ nextUri: 'https://trino.example.com/v1/statement/q/1' },
			{ nextUri: 'https://trino.example.com/v1/statement/q/2' },
			{ nextUri: 'https://trino.example.com/v1/statement/q/3' },
			{ nextUri: 'https://trino.example.com/v1/statement/q/4' },
			{ nextUri: 'https://trino.example.com/v1/statement/q/5' },
			{ nextUri: 'https://trino.example.com/v1/statement/q/6' },
			{ nextUri: 'https://trino.example.com/v1/statement/q/7' },
			{ nextUri: 'https://trino.example.com/v1/statement/q/8' },
		]);
		await expect(browse.listNamespaces(config(), probe, { limit: 10 })).rejects.toThrow(
			'did not finish',
		);
		expect(calls).toHaveLength(8);
	});
});
