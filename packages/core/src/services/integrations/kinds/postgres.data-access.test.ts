import { describe, expect, it } from 'vitest';
import { postgres } from './postgres';

const base = {
	host: 'db.example.test',
	port: 5432,
	database: 'analytics',
	username: 'reader',
	password: 'secret',
	ambient_env: true,
};

describe('PostgreSQL hub data access', () => {
	it('advertises the PostgreSQL engine and dialect', () => {
		expect(postgres.query).toMatchObject({ engine: 'postgres', dialect: 'postgresql' });
	});

	it('creates a closed verified connection capability', () => {
		const config = postgres.configSchema.parse({
			...base,
			ssl: { mode: 'verify-full', ca_bundle: 'test-ca' },
		});
		expect(postgres.databaseBrowse?.source(config)).toEqual({
			provider: 'postgres',
			host: 'db.example.test',
			port: 5432,
			database: 'analytics',
			username: 'reader',
			password: 'secret',
			tls: { mode: 'verify-full', ca: { kind: 'bundle', pem: 'test-ca' } },
		});
		expect(postgres.query?.plan({ config, integration: {} as never })).toMatchObject({
			engine: 'postgres',
		});
	});

	it('uses the fixed system CA when no bundle is pasted', () => {
		const config = postgres.configSchema.parse({ ...base, ssl: { mode: 'verify-ca' } });
		expect(postgres.databaseBrowse?.source(config)).toMatchObject({
			tls: { mode: 'verify-ca', ca: { kind: 'system' } },
		});
	});

	it('keeps a custom CA path sandbox-only', () => {
		const config = postgres.configSchema.parse({
			...base,
			ssl: { mode: 'verify-full', ca_path: '/custom/ca.pem' },
		});
		expect(postgres.databaseBrowse?.available(config)).toEqual({
			ok: false,
			reason: 'Custom CA paths are sandbox-only. Paste the certificate into CA bundle.',
		});
	});

	it('quotes PostgreSQL and Python string delimiters in notebook snippets', () => {
		const snippet = postgres.databaseBrowse?.snippet('analytics', ["team's"], 'Odd " table');

		expect(snippet).toContain('SELECT * FROM \\"team\'s\\".\\"Odd \\"\\" table\\" LIMIT 100');
	});
});
