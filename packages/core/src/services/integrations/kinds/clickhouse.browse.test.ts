import { describe, expect, it } from 'vitest';
import type { IntegrationProbe, ProbeRequestInit } from '../../../ports/integrations';
import { clickhouse } from './clickhouse';

const browse = clickhouse.browse!;
const config = (over: Record<string, unknown> = {}) =>
	clickhouse.configSchema.parse({ host: 'clickhouse.example.com', password: 'secret', ...over });

function result(meta: string[], data: unknown[][]) {
	return { meta: meta.map((name) => ({ name, type: 'String' })), data };
}

function fakeProbe(body: unknown) {
	const calls: { url: string; init?: ProbeRequestInit }[] = [];
	const probe: IntegrationProbe = {
		connect: () => Promise.reject(new Error('unused')),
		fetch: async (url, init) => {
			calls.push({ url, init });
			return { ok: true, status: 200, json: async () => body };
		},
	};
	return { probe, calls };
}

function queuedProbe(bodies: unknown[]) {
	let index = 0;
	const probe: IntegrationProbe = {
		connect: () => Promise.reject(new Error('unused')),
		fetch: async () => ({ ok: true, status: 200, json: async () => bodies[index++] }),
	};
	return probe;
}

describe('clickhouse browse', () => {
	it('blocks TLS modes the guarded probe cannot reproduce', () => {
		expect(browse.available(config())).toEqual({ ok: true });
		expect(browse.available(config({ verify: false }))).toMatchObject({ ok: false });
		expect(browse.available(config({ secure: false }))).toMatchObject({ ok: false });
	});

	it('lists databases and tables through read-only HTTP queries', async () => {
		const databases = fakeProbe(result(['name'], [['default'], ['system']]));
		await expect(browse.listNamespaces(config(), databases.probe, { limit: 1 })).resolves.toEqual({
			items: [['default']],
			next_cursor: 'name:default',
		});
		const databaseUrl = new URL(databases.calls[0].url);
		expect(databaseUrl.searchParams.has('readonly')).toBe(false);
		expect(databases.calls[0].init?.method).toBe('GET');
		expect(databaseUrl.searchParams.get('query')).toBe('SHOW DATABASES FORMAT JSONCompact');

		const tables = fakeProbe(result(['name'], [['orders']]));
		await browse.listTables(config(), tables.probe, ['weird"db'], { limit: 10 });
		expect(new URL(tables.calls[0].url).searchParams.get('query')).toBe(
			'SHOW TABLES FROM "weird""db" FORMAT JSONCompact',
		);
	});

	it('maps DESCRIBE output and previews rows', async () => {
		const schema = fakeProbe(
			result(
				['name', 'type', 'default_type', 'default_expression', 'comment'],
				[
					['id', 'Nullable(UInt64)', '', '', 'identifier'],
					['nickname', 'LowCardinality(Nullable(String))', '', '', ''],
					['status', 'LowCardinality(String)', '', '', ''],
				],
			),
		);
		await expect(
			browse.getTableSchema(config(), schema.probe, ['default'], 'orders'),
		).resolves.toEqual({
			columns: [
				{ name: 'id', type: 'Nullable(UInt64)', nullable: true, comment: 'identifier' },
				{ name: 'nickname', type: 'LowCardinality(Nullable(String))', nullable: true },
				{ name: 'status', type: 'LowCardinality(String)', nullable: false },
			],
		});

		const preview = fakeProbe(result(['id', 'name'], [[1, 'Ada']]));
		await expect(
			browse.previewRows!(config(), preview.probe, ['default'], 'orders', { limit: 20 }),
		).resolves.toEqual({ columns: ['id', 'name'], rows: [[1, 'Ada']] });
		expect(new URL(preview.calls[0].url).searchParams.get('query')).toBe(
			'SELECT * FROM "default"."orders" LIMIT 20 FORMAT JSONCompact',
		);
	});

	it('uses stable name cursors when metadata changes between pages', async () => {
		const probe = queuedProbe([
			result(['name'], [['alpha'], ['beta'], ['delta']]),
			result(['name'], [['aardvark'], ['beta'], ['delta'], ['epsilon']]),
		]);
		const first = await browse.listNamespaces(config(), probe, { limit: 2 });
		expect(first).toEqual({ items: [['alpha'], ['beta']], next_cursor: 'name:beta' });

		await expect(
			browse.listNamespaces(config(), probe, { limit: 2, cursor: first.next_cursor! }),
		).resolves.toEqual({ items: [['delta'], ['epsilon']], next_cursor: null });
	});

	it('rejects malformed browse cursors', async () => {
		const { probe } = fakeProbe(result(['name'], [['default']]));
		await expect(
			browse.listNamespaces(config(), probe, { limit: 1, cursor: 'offset:1' }),
		).rejects.toThrow('Invalid browse cursor');
	});
});
