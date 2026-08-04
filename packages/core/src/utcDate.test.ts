import { describe, expect, it } from 'vitest';
import { parseUtcDate } from './utcDate';

describe('parseUtcDate', () => {
	it('parses real ISO calendar dates at UTC midnight', () => {
		expect(parseUtcDate('2024-02-29')).toBe(Date.parse('2024-02-29T00:00:00.000Z'));
	});

	it.each(['2025-02-29', '2025-02-30', '2025-13-01', '2025-1-01', 'not-a-date'])(
		'rejects %s',
		(value) => {
			expect(parseUtcDate(value)).toBeNull();
		},
	);
});
