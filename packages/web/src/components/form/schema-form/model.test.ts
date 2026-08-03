import { describe, it, expect } from 'vitest';
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
	validateValue,
} from './model';
import type { JsonSchemaNode, UiHints } from './model';

/** Fixture covering defaults, secrets, unions, and key/value records. */
const schema: JsonSchemaNode = {
	type: 'object',
	required: ['host', 'database', 'username', 'password'],
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
