import { z } from 'zod';
import { UnavailableError } from '@marimo-hub/core';
import type { TableColumn } from '@marimo-hub/core';

export interface BigQueryField {
	name: string;
	type: string;
	mode?: 'NULLABLE' | 'REQUIRED' | 'REPEATED';
	description?: string;
	fields?: BigQueryField[];
}

const fieldSchema: z.ZodType<BigQueryField> = z.lazy(() =>
	z.object({
		name: z.string(),
		type: z.string(),
		mode: z.enum(['NULLABLE', 'REQUIRED', 'REPEATED']).optional(),
		description: z.string().optional(),
		fields: z.array(fieldSchema).optional(),
	}),
);
export const tableSchema = z.object({
	type: z.string(),
	schema: z.object({ fields: z.array(fieldSchema) }),
	timePartitioning: z.object({ field: z.string().optional(), type: z.string() }).optional(),
	rangePartitioning: z.object({ field: z.string() }).optional(),
});
const rowSchema = z.object({ f: z.array(z.object({ v: z.unknown() })) });
export const dataSchema = z.object({ rows: z.array(rowSchema).optional() });

export function parseResponse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
	const parsed = schema.safeParse(body);
	if (!parsed.success)
		throw new UnavailableError('BigQuery returned invalid metadata or row data.');
	return parsed.data;
}

export function tableColumns(fields: BigQueryField[]): TableColumn[] {
	return fields.map((field) => ({
		name: field.name,
		type: fieldType(field),
		nullable: field.mode !== 'REQUIRED' && field.mode !== 'REPEATED',
		...(field.description ? { comment: field.description } : {}),
	}));
}

function fieldType(field: BigQueryField): string {
	const type =
		field.type === 'RECORD' || field.type === 'STRUCT'
			? `STRUCT<${(field.fields ?? []).map((child) => `${child.name} ${fieldType(child)}`).join(', ')}>`
			: field.type;
	return field.mode === 'REPEATED' ? `ARRAY<${type}>` : type;
}

export function decodeRow(fields: BigQueryField[], row: z.infer<typeof rowSchema>): unknown[] {
	if (row.f.length !== fields.length)
		throw new UnavailableError('BigQuery returned a row with an unexpected column count.');
	return fields.map((field, index) => decodeValue(field, row.f[index].v));
}

function decodeValue(field: BigQueryField, value: unknown): unknown {
	if (value === null) return null;
	if (field.mode === 'REPEATED') {
		const items = parseResponse(z.array(z.object({ v: z.unknown() })), value);
		return items.map((item) => decodeValue({ ...field, mode: 'NULLABLE' }, item.v));
	}
	if (field.type === 'RECORD' || field.type === 'STRUCT') {
		const fields = field.fields ?? [];
		const values = decodeRow(fields, parseResponse(rowSchema, value));
		return Object.fromEntries(fields.map((child, index) => [child.name, values[index]]));
	}
	if (typeof value !== 'string')
		throw new UnavailableError('BigQuery returned an invalid scalar value.');
	if (field.type === 'BOOLEAN' || field.type === 'BOOL') {
		if (value === 'true') return true;
		if (value === 'false') return false;
		throw new UnavailableError('BigQuery returned an invalid boolean value.');
	}
	// Keep INT64, NUMERIC, and BIGNUMERIC exact across the JSON boundary.
	if (field.type === 'FLOAT' || field.type === 'FLOAT64') {
		const number = Number(value);
		return Number.isFinite(number) ? number : value;
	}
	return value;
}
