import { expect, it } from 'vitest';
import { createHub, integration, secret } from './index';
import type { IntegrationSpec } from './index';

it('preserves authoring types', () => {
	const config = {
		host: 'db',
		database: 'db',
		username: 'user',
		password: secret.ref('vault', 'db#password'),
	};
	expect(integration('postgres', 'db', config).kind).toBe('postgres');
	integration('otlp_logs', 'logs', {
		url: 'https://logs.example',
		auth: { method: 'headers', headers: [{ name: 'Authorization', value: secret.keep() }] },
	});
	const plain = { kind: 'postgres', name: 'db', config } satisfies IntegrationSpec;
	expect(plain.kind).toBe('postgres');
});

function rejectedTypes() {
	// @ts-expect-error Misspelled built-in kind.
	integration('postgress', 'db', {});
	// @ts-expect-error Required database connection fields.
	integration('postgres', 'db', {});
	integration('postgres', 'db', {
		host: 'db',
		database: 'db',
		username: 'user',
		password: 'pw',
		// @ts-expect-error Port must be numeric.
		port: '5432',
	});
	integration('postgres', 'db', {
		host: 'db',
		database: 'db',
		username: 'user',
		password: 'pw',
		// @ts-expect-error Invalid nested discriminator.
		ssl: { mode: 'unknown' },
	});
	integration('postgres', 'db', {
		host: 'db',
		database: 'db',
		username: 'user',
		password: 'pw',
		// @ts-expect-error Unknown configuration key.
		typo: true,
	});
	void createHub({ url: 'https://hub.example', token: 't' })
		.project('p')
		// @ts-expect-error Direct objects cannot use the custom escape hatch.
		.integrations.upsert({ kind: 'postgress', name: 'db', config: {} });
	void createHub({ url: 'https://hub.example', token: 't' })
		.project('p')
		// @ts-expect-error Direct objects require the selected config.
		.integrations.upsert({ kind: 'postgres', name: 'db', config: {} });
}
void rejectedTypes;
