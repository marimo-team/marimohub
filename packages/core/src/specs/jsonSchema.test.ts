import { expect, it } from 'vitest';
import { z } from 'zod';
import { jsonSchema } from './jsonSchema';

it('preserves null in the established nullable union representation at each schema depth', () => {
	const nullable = { anyOf: [{ type: 'string' }, { type: 'null' }] };
	const schema = z.object({
		id: z.string().nullable().describe('Previous identifier'),
		ids: z.array(z.string().nullable()),
		mapping: z.record(z.string(), z.string().nullable()),
		nested: z.union([z.object({ id: z.string().nullable() }), z.literal(false)]),
	});
	expect(jsonSchema(schema)).toMatchObject({
		properties: {
			id: { ...nullable, description: 'Previous identifier' },
			ids: { items: nullable },
			mapping: { additionalProperties: nullable },
			nested: { anyOf: [{ properties: { id: nullable } }, { const: false }] },
		},
	});
	expect(jsonSchema(z.string().nullable())).toEqual(nullable);
});

it('keeps constrained nullable branches and non-nullable unions unchanged', () => {
	for (const schema of [
		z.string().min(1).nullable(),
		z.enum(['ready', 'done']).nullable(),
		z.union([z.string(), z.number()]),
		z.discriminatedUnion('kind', [
			z.object({ kind: z.literal('first'), value: z.string().min(1) }),
			z.object({ kind: z.literal('second'), value: z.number().positive() }),
		]),
	]) {
		const { $schema: _, ...original } = z.toJSONSchema(schema, { io: 'input' });
		expect(jsonSchema(schema)).toEqual(original);
	}
});

it('does not rewrite schema-shaped defaults or examples as schemas', () => {
	const value = { type: ['string', 'null'] };
	const schema = z
		.unknown()
		.default(value)
		.meta({ examples: [value] });
	expect(jsonSchema(schema)).toEqual({ default: value, examples: [value] });
});
