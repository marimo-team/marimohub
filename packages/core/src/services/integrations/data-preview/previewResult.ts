import { UnavailableError } from '../../../errors';
import { isRecord } from '../../../internal/validation';
import type { TablePreview } from '../../../ports/integrations';

export function parseTablePreviewJson(serialized: string, maxRows: number): TablePreview {
	let value: unknown;
	try {
		value = JSON.parse(serialized.trim());
	} catch {
		throw invalidPreview();
	}
	if (!isRecord(value)) throw invalidPreview();
	return validateTableData(value.columns, value.rows, { maxRows, invalid: invalidPreview });
}

export function validateTableData(
	columns: unknown,
	rows: unknown,
	options: { maxRows?: number; invalid: () => Error },
): TablePreview {
	if (
		!Array.isArray(columns) ||
		!columns.every((column): column is string => typeof column === 'string') ||
		!Array.isArray(rows) ||
		(options.maxRows !== undefined && rows.length > options.maxRows) ||
		!rows.every((row): row is unknown[] => Array.isArray(row) && row.length === columns.length)
	) {
		throw options.invalid();
	}
	return { columns, rows };
}

function invalidPreview(): UnavailableError {
	return new UnavailableError('The preview sandbox returned an invalid result.');
}
