import { z } from 'zod';
import { isRecord } from '../internal/validation';

function preserveNullableUnions(schema: unknown): void {
	if (Array.isArray(schema)) {
		schema.forEach(preserveNullableUnions);
		return;
	}
	if (!isRecord(schema)) return;
	const types = schema.type;
	if (Array.isArray(types) && types.length === 2 && types.includes('null') && !schema.anyOf) {
		delete schema.type;
		schema.anyOf = types.map((type) => ({ type }));
	}
	for (const keyword of ['properties', 'patternProperties', '$defs']) {
		const children = schema[keyword];
		if (isRecord(children)) preserveNullableUnions(Object.values(children));
	}
	for (const keyword of [
		'anyOf',
		'oneOf',
		'allOf',
		'prefixItems',
		'items',
		'additionalProperties',
		'propertyNames',
		'not',
	]) {
		preserveNullableUnions(schema[keyword]);
	}
}

export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
	// Stored bytes are inputs, so defaults remain optional and transforms keep their input shape.
	const { $schema: _, ...result } = z.toJSONSchema(schema, { io: 'input' });
	// Zod 4.6 compacts nullable unions; oasdiff treats that equivalent shape as narrowing.
	preserveNullableUnions(result);
	return result;
}
