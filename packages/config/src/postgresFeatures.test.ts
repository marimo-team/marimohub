import { describe, expect, it } from 'vitest';
import { postgresDataAccessFeatures, postgresDataAccessGate } from './postgresFeatures';

describe('PostgreSQL data-access features', () => {
	it('defaults data access and insecure transport off and accepts only on or off', () => {
		expect(postgresDataAccessFeatures({})).toEqual({
			enabled: false,
			allowInsecureTransport: false,
		});
		expect(
			postgresDataAccessFeatures({
				MARIMOHUB_POSTGRES_DATA_ACCESS: ' ON ',
				MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT: ' ON ',
			}),
		).toEqual({ enabled: true, allowInsecureTransport: true });
		expect(() =>
			postgresDataAccessFeatures({
				MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT: 'enabled',
			}),
		).toThrow('Unknown MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT');
	});

	it('rejects invalid data-access flag values', () => {
		expect(() => postgresDataAccessFeatures({ MARIMOHUB_POSTGRES_DATA_ACCESS: 'enabled' })).toThrow(
			'Unknown MARIMOHUB_POSTGRES_DATA_ACCESS',
		);
	});

	it('permits verified TLS without the transport override', () => {
		const gate = postgresDataAccessGate({ enabled: true, allowInsecureTransport: false });

		expect(gate({ kind: 'postgres', config: { ssl: { mode: 'verify-ca' } } })).toBeUndefined();
		expect(gate({ kind: 'postgres', config: { ssl: { mode: 'verify-full' } } })).toBeUndefined();
	});

	it.each(['disable', 'prefer', 'require'])('requires the transport override for %s', (mode) => {
		const blocked = postgresDataAccessGate({ enabled: true, allowInsecureTransport: false });
		const allowed = postgresDataAccessGate({ enabled: true, allowInsecureTransport: true });

		expect(blocked({ kind: 'postgres', config: { ssl: { mode } } })).toMatchObject({
			id: 'postgres-insecure-transport',
			ready: false,
			field: 'ssl.mode',
		});
		expect(allowed({ kind: 'postgres', config: { ssl: { mode } } })).toBeUndefined();
	});

	it('leaves other integration kinds unchanged', () => {
		const gate = postgresDataAccessGate({ enabled: false, allowInsecureTransport: false });

		expect(gate({ kind: 's3', config: {} })).toBeUndefined();
	});
});

describe('PostgreSQL gate hardening', () => {
	const gate = postgresDataAccessGate({ enabled: true, allowInsecureTransport: false });

	it('blocks PostgreSQL access unless the rollout flag is enabled', () => {
		const disabled = postgresDataAccessGate({ enabled: false, allowInsecureTransport: true });
		expect(disabled({ kind: 'postgres', config: {} })).toMatchObject({
			id: 'postgres-data-access',
			ready: false,
		});
	});

	it.each([
		null,
		undefined,
		'disable',
		42,
		[],
		{},
		{ ssl: null },
		{ ssl: 'disable' },
		{ ssl: [] },
		{ ssl: {} },
		{ ssl: { mode: null } },
		{ ssl: { mode: 42 } },
		{ ssl: { mode: ['disable'] } },
	])('tolerates malformed config %j without crashing (schema stores canonical modes)', (config) => {
		expect(gate({ kind: 'postgres', config })).toBeUndefined();
	});

	it('blocks exactly the three canonical insecure literals', () => {
		for (const mode of ['disable', 'prefer', 'require']) {
			expect(gate({ kind: 'postgres', config: { ssl: { mode } } })).toBeDefined();
		}
		// Non-canonical spellings never reach the gate: the schema's strict
		// literals reject them at authoring time.
		for (const mode of ['DISABLE', ' prefer', 'require ', 'verify-ca', 'verify-full']) {
			expect(gate({ kind: 'postgres', config: { ssl: { mode } } })).toBeUndefined();
		}
	});

	it('rejects boolean-ish env aliases for the transport override', () => {
		for (const value of ['true', 'false', '1', '0', 'yes', 'enabled']) {
			expect(() =>
				postgresDataAccessFeatures({ MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT: value }),
			).toThrow('Unknown MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT');
		}
	});
});
