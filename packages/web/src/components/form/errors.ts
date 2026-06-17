import type { AnyFieldMeta } from '@tanstack/react-form';

/**
 * First error message for a field, or `undefined` if untouched or error-free.
 * zod (Standard Schema) yields issue *objects*, plain validators yield strings —
 * handle both. Gating on `isTouched` stops required errors flashing before the
 * field is interacted with.
 */
export function firstError(meta: AnyFieldMeta): string | undefined {
	if (!meta.isTouched) return undefined;
	const e = meta.errors[0];
	if (e == null) return undefined;
	return typeof e === 'string' ? e : (e.message as string);
}
