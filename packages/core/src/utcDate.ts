export const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseUtcDate(value: string): number | null {
	if (!UTC_DATE_PATTERN.test(value)) return null;
	const parsed = Date.parse(`${value}T00:00:00.000Z`);
	return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
		? parsed
		: null;
}
