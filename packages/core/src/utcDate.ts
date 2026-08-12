export const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

export function parseUtcDate(value: string): number | null {
	if (!UTC_DATE_PATTERN.test(value)) return null;
	const parsed = Date.parse(`${value}T00:00:00.000Z`);
	return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
		? parsed
		: null;
}

export function parseIsoTimestamp(value: string): number | null {
	const match = ISO_TIMESTAMP_PATTERN.exec(value);
	if (!match) return null;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return null;
	const date = new Date(parsed);
	const expected = match.slice(1, 7).map(Number);
	const actual = [
		date.getUTCFullYear(),
		date.getUTCMonth() + 1,
		date.getUTCDate(),
		date.getUTCHours(),
		date.getUTCMinutes(),
		date.getUTCSeconds(),
	];
	return actual.every((part, index) => part === expected[index]) ? parsed : null;
}

export function nextIsoTimestamp(previous: string | undefined, candidate: string): string {
	const candidateMs = parseIsoTimestamp(candidate);
	if (candidateMs === null) {
		throw new RangeError('Timestamps must be valid ISO date-time strings');
	}
	if (previous === undefined) return candidate;
	const previousMs = parseIsoTimestamp(previous);
	if (previousMs === null) {
		throw new RangeError('Timestamps must be valid ISO date-time strings');
	}
	return candidateMs > previousMs ? candidate : new Date(previousMs + 1).toISOString();
}
