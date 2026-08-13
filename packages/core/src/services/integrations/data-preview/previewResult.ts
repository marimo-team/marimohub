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
	if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) {
		throw invalidPreview();
	}
	if (!value.columns.every((column) => typeof column === 'string')) throw invalidPreview();
	const columns = value.columns;
	if (
		value.rows.length > maxRows ||
		!value.rows.every(
			(row): row is unknown[] => Array.isArray(row) && row.length === columns.length,
		)
	) {
		throw invalidPreview();
	}
	return { columns, rows: value.rows };
}

function invalidPreview(): UnavailableError {
	return new UnavailableError('The preview sandbox returned an invalid result.');
}
