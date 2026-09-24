import { describe, it, expect } from 'vitest';
import { icebergRest } from '../../../../../core/src/services/integrations/kinds/icebergRest';
import { IntegrationRegistry } from '../../../../../core/src/services/integrations/registry';
import {
	branchDiscriminator,
	branchForValue,
	buildDefaults,
	groupFields,
	hintFor,
	isKeepMarker,
	KEEP_SECRET,
	needsSecretSource,
	pruneForSubmit,
	redactSecretsForRequest,
	validateValue,
} from './model';
import type { JsonSchemaNode, UiHints } from './model';

/** Fixture covering defaults, secrets, unions, and key/value records. */
const schema: JsonSchemaNode = {
	type: 'object',
	required: ['host', 'database', 'username', 'password', 'auth'],
	properties: {
		host: { type: 'string' },
		port: { type: 'integer', minimum: 1, maximum: 65535, default: 5432 },
		database: { type: 'string' },
		username: { type: 'string' },
		password: { type: 'string', minLength: 1, 'x-marimohub-secret': true },
		ssl: { type: 'boolean', default: true },
		auth: {
			oneOf: [
				{
					type: 'object',
					required: ['method'],
					properties: { method: { type: 'string', const: 'none' } },
				},
				{
					type: 'object',
					required: ['method', 'user'],
					properties: {
						method: { type: 'string', const: 'basic' },
						user: { type: 'string' },
					},
				},
			],
		},
		props: {
			type: 'object',
			propertyNames: { pattern: '^[a-z]+$' },
			additionalProperties: { type: 'string' },
			default: {},
		},
	},
};

const authNode = schema.properties!.auth;

describe('optional config objects', () => {
	const credentials: JsonSchemaNode = {
		type: 'object',
		required: ['token'],
		properties: {
			token: { type: 'string', 'x-marimohub-secret': true },
			region: { type: 'string', default: 'us-east-1' },
		},
	};
	const optionalSchema: JsonSchemaNode = {
		type: 'object',
		properties: {
			credentials,
			connection: { anyOf: [credentials] },
		},
	};

	it('keeps absent objects and object unions out of defaults, submissions, and readiness', () => {
		const value = buildDefaults(optionalSchema);
		expect(value).toEqual({});
		expect(pruneForSubmit(optionalSchema, value)).toEqual({});
		expect(redactSecretsForRequest(optionalSchema, value)).toEqual({});
		expect(validateValue(optionalSchema, value)).toEqual({});
		expect(needsSecretSource(optionalSchema, value)).toBe(false);
	});

	it('validates enabled objects and keeps their defaults and secrets', () => {
		const value = { credentials: buildDefaults(credentials) };
		expect(validateValue(optionalSchema, value)).toEqual({ 'credentials.token': 'Required' });
		expect(pruneForSubmit(optionalSchema, value)).toEqual(value);
		expect(needsSecretSource(optionalSchema, value)).toBe(true);
		expect(redactSecretsForRequest(optionalSchema, value)).toEqual({
			credentials: { token: KEEP_SECRET, region: 'us-east-1' },
		});
	});

	it('keeps required and defaulted objects enabled', () => {
		const requiredSchema: JsonSchemaNode = {
			...optionalSchema,
			required: ['credentials'],
			properties: {
				credentials,
				connection: { ...credentials, default: { token: '', region: 'eu-west-1' } },
			},
		};
		expect(buildDefaults(requiredSchema)).toEqual({
			credentials: { token: '', region: 'us-east-1' },
			connection: { token: '', region: 'eu-west-1' },
		});
		expect(validateValue(requiredSchema, {})).toHaveProperty('credentials.token');
	});

	it('preserves configured objects and omits explicitly disabled objects', () => {
		const raw = { credentials: { token: KEEP_SECRET, region: 'eu-west-1' }, connection: undefined };
		const submitted = pruneForSubmit(optionalSchema, raw);
		expect(submitted).toEqual({ credentials: raw.credentials });
		expect(redactSecretsForRequest(optionalSchema, submitted, raw)).toEqual(submitted);
	});

	it('preserves evidence of invalid object shapes during redaction', () => {
		expect(redactSecretsForRequest(optionalSchema, {}, { credentials: 'secret' })).toEqual({
			credentials: null,
		});
		expect(
			redactSecretsForRequest(optionalSchema, {}, { credentials: { unknown: 'secret' } }),
		).toEqual({
			credentials: { unknown: null },
		});
	});
});

describe('Iceberg REST form submissions', () => {
	const registry = new IntegrationRegistry();
	registry.register(icebergRest);
	const icebergSchema = registry.jsonSchema('iceberg_rest') as JsonSchemaNode;
	const storageSchema = icebergSchema.properties!.storage;
	const catalogBranch = branchForValue(storageSchema, { scheme: 'catalog' })!;
	const vendedSchema = catalogBranch.properties!.vended_s3;
	const base = {
		uri: 'https://catalog.cloudflarestorage.com/account-id/warehouse',
		auth: { method: 'bearer_token', token: 'test-token' },
	};

	it.each(['create', 'edit', 'switch storage'])(
		'omits vended S3 for R2 Data Catalog during %s',
		(flow) => {
			const value = {
				...(buildDefaults(icebergSchema) as Record<string, unknown>),
				...base,
				storage: flow === 'switch storage' ? buildDefaults(catalogBranch) : { scheme: 'catalog' },
			};
			const raw = flow === 'edit' ? icebergRest.configSchema.parse(value) : value;
			const submitted = pruneForSubmit(icebergSchema, raw) as Record<string, unknown>;
			expect(submitted.storage).toEqual({ scheme: 'catalog' });
			expect(validateValue(icebergSchema, raw)).toEqual({});
			expect(redactSecretsForRequest(icebergSchema, submitted, raw)).toMatchObject({
				storage: { scheme: 'catalog' },
				auth: { token: KEEP_SECRET },
			});
			expect(
				(redactSecretsForRequest(icebergSchema, submitted, raw) as typeof submitted).storage,
			).toEqual({ scheme: 'catalog' });
			const parsed = icebergRest.configSchema.parse(submitted);
			expect(() => icebergRest.validate?.(parsed)).not.toThrow();
			expect(icebergRest.query?.readiness?.(parsed).every((check) => check.ready)).toBe(true);
		},
	);

	it('retains and rejects a partially configured vended S3 block', () => {
		const raw = {
			...base,
			storage: {
				scheme: 'catalog',
				vended_s3: {
					...(buildDefaults(vendedSchema) as Record<string, unknown>),
					region: 'eu-west-1',
				},
			},
		};
		const submitted = pruneForSubmit(icebergSchema, raw);
		expect(validateValue(icebergSchema, raw)).toHaveProperty('storage.vended_s3.endpoint');
		expect(icebergRest.configSchema.safeParse(submitted).success).toBe(false);
		expect(redactSecretsForRequest(icebergSchema, submitted, raw)).toMatchObject({
			storage: { vended_s3: { endpoint: '', allowed_locations: [] } },
		});
	});

	it('retains valid vended S3 settings for generic catalogs', () => {
		const storage = {
			scheme: 'catalog',
			vended_s3: {
				endpoint: 'https://objects.example.com',
				region: 'us-east-1',
				force_virtual_addressing: false,
				allowed_locations: [{ bucket: 'warehouse', prefix: 'production' }],
			},
		};
		const raw = { ...base, uri: 'https://catalog.example.com', storage };
		const submitted = pruneForSubmit(icebergSchema, raw) as Record<string, unknown>;
		expect(submitted.storage).toEqual(storage);
		expect(validateValue(icebergSchema, raw)).toEqual({});
		expect(() => icebergRest.validate?.(icebergRest.configSchema.parse(submitted))).not.toThrow();
	});
});

describe('buildDefaults', () => {
	it('fills scalar defaults, empty strings, and the first union branch with its discriminator', () => {
		expect(buildDefaults(schema)).toEqual({
			host: '',
			port: 5432,
			database: '',
			username: '',
			password: '',
			ssl: true,
			auth: { method: 'none' },
			props: {},
		});
	});

	it('drops in the const discriminator without recursing into buildDefaults for it', () => {
		const basicBranch = authNode.oneOf![1];
		expect(buildDefaults(basicBranch)).toEqual({ method: 'basic', user: '' });
	});
});

describe('validateValue', () => {
	it('flags missing required strings (including a required secret)', () => {
		const errors = validateValue(schema, buildDefaults(schema));
		expect(errors).toEqual({
			host: 'Required',
			database: 'Required',
			username: 'Required',
			password: 'Required',
		});
	});

	it('passes a fully valid value', () => {
		const value = {
			host: 'db.internal',
			port: 5432,
			database: 'app',
			username: 'admin',
			password: 'hunter2',
			ssl: true,
			auth: { method: 'none' },
			props: {},
		};
		expect(validateValue(schema, value)).toEqual({});
	});

	it('flags a non-numeric port', () => {
		const value = { ...validValue(), port: 'abc' };
		expect(validateValue(schema, value)).toEqual({ port: 'Must be a number' });
	});

	it('flags an out-of-range port (below minimum)', () => {
		const value = { ...validValue(), port: 0 };
		expect(validateValue(schema, value)).toEqual({ port: 'Must be ≥ 1' });
	});

	it('flags an out-of-range port (above maximum)', () => {
		const value = { ...validValue(), port: 70000 };
		expect(validateValue(schema, value)).toEqual({ port: 'Must be ≤ 65535' });
	});

	it('flags a bad record key against propertyNames.pattern', () => {
		const value = { ...validValue(), props: { BAD_KEY: 'x', ok: 'y' } };
		expect(validateValue(schema, value)).toEqual({ 'props.BAD_KEY': 'Invalid name "BAD_KEY"' });
	});

	it('does not require a source for an omitted optional secret', () => {
		const optionalSecretSchema: JsonSchemaNode = {
			type: 'object',
			properties: {
				password: { type: 'string', minLength: 1, 'x-marimohub-secret': true },
			},
		};
		const unavailable = { inline: false, references: [] };
		expect(validateValue(optionalSecretSchema, { password: '' }, '', true, unavailable)).toEqual(
			{},
		);
		expect(needsSecretSource(optionalSecretSchema, { password: '' })).toBe(false);
		expect(needsSecretSource(optionalSecretSchema, { password: 'set' })).toBe(true);
	});

	function validValue() {
		return {
			host: 'db.internal',
			port: 5432,
			database: 'app',
			username: 'admin',
			password: 'hunter2',
			ssl: true,
			auth: { method: 'none' },
			props: {},
		};
	}
});

describe('pruneForSubmit', () => {
	it('keeps required fields even when empty, drops undefined optionals, and drops empty kv keys', () => {
		const value = {
			host: 'h',
			port: undefined,
			database: '',
			username: 'u',
			password: '',
			ssl: true,
			auth: { method: 'none' },
			props: { '': 'x', ok: 'y' },
		};
		expect(pruneForSubmit(schema, value)).toEqual({
			host: 'h',
			database: '',
			username: 'u',
			password: '',
			ssl: true,
			auth: { method: 'none' },
			props: { ok: 'y' },
		});
	});

	it('drops an empty optional array with no default, keeping defaulted and required ones', () => {
		const item: JsonSchemaNode = {
			type: 'object',
			required: ['value'],
			properties: { value: { type: 'string' } },
		};
		const arraySchema: JsonSchemaNode = {
			type: 'object',
			required: ['tags'],
			properties: {
				// `z.array(...).min(1).optional()`: the server rejects `[]`.
				encoding: { type: 'array', items: item },
				// `z.array(...).default([])`: an empty list is a legal, deliberate value.
				client_tags: { type: 'array', items: item, default: [] },
				tags: { type: 'array', items: item },
			},
		};
		expect(pruneForSubmit(arraySchema, { encoding: [], client_tags: [], tags: [] })).toEqual({
			client_tags: [],
			tags: [],
		});
		expect(
			pruneForSubmit(arraySchema, { encoding: [{ value: 'json' }], client_tags: [], tags: [] }),
		).toEqual({ encoding: [{ value: 'json' }], client_tags: [], tags: [] });
	});

	it('drops an empty optional array nested in the selected union branch', () => {
		const unionSchema: JsonSchemaNode = {
			oneOf: [
				{
					type: 'object',
					required: ['method'],
					properties: {
						method: { type: 'string', const: 'spool' },
						encoding: {
							type: 'array',
							items: { type: 'object', properties: { value: { type: 'string' } } },
						},
					},
				},
			],
		};
		expect(pruneForSubmit(unionSchema, { method: 'spool', encoding: [] })).toEqual({
			method: 'spool',
		});
	});

	it('drops an empty optional string but keeps a non-empty one', () => {
		const optionalStringSchema: JsonSchemaNode = {
			type: 'object',
			required: [],
			properties: { nickname: { type: 'string' } },
		};
		expect(pruneForSubmit(optionalStringSchema, { nickname: '' })).toEqual({});
		expect(pruneForSubmit(optionalStringSchema, { nickname: 'bud' })).toEqual({ nickname: 'bud' });
	});

	it('drops an empty optional secret', () => {
		const optionalSecretSchema: JsonSchemaNode = {
			type: 'object',
			properties: {
				password: { type: 'string', minLength: 1, 'x-marimohub-secret': true },
			},
		};
		expect(pruneForSubmit(optionalSecretSchema, { password: '' })).toEqual({});
	});
});

describe('redactSecretsForRequest', () => {
	it('redacts secret-capable values and retains evidence of unknown fields', () => {
		const raw = {
			host: 'db.internal',
			database: 'app',
			username: 'admin',
			password: 'must-not-leave-the-form',
			auth: { method: 'basic', user: 'reader', unexpected: 'nested-secret' },
			props: { '': 'discarded-record-secret', region: 'record-secret' },
			unexpected: 'root-secret',
		};
		const redacted = redactSecretsForRequest(schema, pruneForSubmit(schema, raw), raw);

		expect(redacted).toEqual({
			host: 'db.internal',
			database: 'app',
			username: 'admin',
			password: KEEP_SECRET,
			auth: { method: 'basic', user: 'reader', unexpected: null },
			props: { region: '' },
			unexpected: null,
		});
		expect(JSON.stringify(redacted)).not.toMatch(
			/must-not|nested-secret|record-secret|discarded-record-secret|root-secret/,
		);
	});

	it('does not restore an empty optional array removed during pruning', () => {
		const optionalArraySchema: JsonSchemaNode = {
			type: 'object',
			properties: {
				values: { type: 'array', items: { type: 'string' } },
			},
		};
		const raw = { values: [] };
		expect(
			redactSecretsForRequest(optionalArraySchema, pruneForSubmit(optionalArraySchema, raw), raw),
		).toEqual({});
	});

	it('retains evidence of an invalid array shape when the pruned value is absent', () => {
		const optionalArraySchema: JsonSchemaNode = {
			type: 'object',
			properties: {
				values: { type: 'array', items: { type: 'string' } },
			},
		};
		expect(redactSecretsForRequest(optionalArraySchema, {}, { values: 'invalid' })).toEqual({
			values: null,
		});
	});

	it('preserves an invalid record shape without retaining its value', () => {
		const props = schema.properties!.props;
		expect(redactSecretsForRequest(props, {}, 'credential')).toBeNull();
	});
});

describe('branchForValue', () => {
	it('picks the branch matching the discriminator', () => {
		const branch = branchForValue(authNode, { method: 'basic', user: 'bob' });
		expect(branchDiscriminator(branch!)).toEqual({ key: 'method', value: 'basic' });
	});

	it('falls back to the first branch when no discriminator matches', () => {
		const branch = branchForValue(authNode, undefined);
		expect(branchDiscriminator(branch!)).toEqual({ key: 'method', value: 'none' });
	});
});

describe('hintFor', () => {
	it('matches an exact path', () => {
		const hints: UiHints = { host: { order: 3 } };
		expect(hintFor(hints, 'host')).toEqual({ order: 3 });
	});

	it('matches a wildcard hint against an indexed path', () => {
		const hints: UiHints = { 'secrets.*.value': { widget: 'password' } };
		expect(hintFor(hints, 'secrets[2].value')).toEqual({ widget: 'password' });
	});

	it('returns undefined when nothing matches', () => {
		expect(hintFor({}, 'host')).toBeUndefined();
	});
});

describe('isKeepMarker', () => {
	it('recognizes the keep-marker shape', () => {
		expect(isKeepMarker(KEEP_SECRET)).toBe(true);
		expect(isKeepMarker({ $secret: { set: true } })).toBe(true);
	});

	it('rejects plain objects, strings, and near-misses', () => {
		expect(isKeepMarker({})).toBe(false);
		expect(isKeepMarker('secret')).toBe(false);
		expect(isKeepMarker(null)).toBe(false);
		expect(isKeepMarker({ $secret: { set: false } })).toBe(false);
		expect(isKeepMarker({ $secret: {} })).toBe(false);
	});
});

describe('groupFields', () => {
	it('orders by hint order and sinks advanced groups last regardless of their order', () => {
		const groupSchema: JsonSchemaNode = {
			type: 'object',
			properties: {
				a: { type: 'string' },
				b: { type: 'string' },
				c: { type: 'string' },
				d: { type: 'string' },
			},
		};
		const hints: UiHints = {
			c: { order: 0, group: 'Advanced', advanced: true },
			a: { order: 1, group: 'Connection' },
			b: { order: 2, group: 'Connection' },
			d: { order: 3 },
		};
		const groups = groupFields(groupSchema, hints);
		expect(
			groups.map((g) => ({
				title: g.title,
				advanced: g.advanced,
				keys: g.fields.map((f) => f.key),
			})),
		).toEqual([
			{ title: 'Connection', advanced: false, keys: ['a', 'b'] },
			{ title: '', advanced: false, keys: ['d'] },
			{ title: 'Advanced', advanced: true, keys: ['c'] },
		]);
	});

	it('defaults to property declaration order in a single untitled group when no hints are given', () => {
		const groupSchema: JsonSchemaNode = {
			type: 'object',
			properties: { x: { type: 'string' }, y: { type: 'string' }, z: { type: 'string' } },
		};
		const groups = groupFields(groupSchema, {});
		expect(groups).toHaveLength(1);
		expect(groups[0].fields.map((f) => f.key)).toEqual(['x', 'y', 'z']);
	});
});
