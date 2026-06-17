import type { StandardSchemaV1 } from '@tanstack/react-form';

/**
 * Run one schema in every phase. `onMount` makes `canSubmit` reflect validity
 * from the start, not just after the first edit; messages still wait for the
 * field to be touched (see {@link firstError}).
 */
export function schemaValidators<T extends StandardSchemaV1>(schema: T) {
	return { onMount: schema, onChange: schema, onSubmit: schema };
}
