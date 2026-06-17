import { describe, it, expect } from 'vitest';
import { formatDuration, formatRelative } from './time';

const NOW = Date.parse('2026-06-24T12:00:00Z');
const ago = (secs: number) => new Date(NOW - secs * 1000).toISOString();

describe('formatRelative', () => {
	it('shows "just now" for very recent (and future) timestamps', () => {
		expect(formatRelative(ago(5), NOW)).toBe('just now');
		expect(formatRelative(ago(-30), NOW)).toBe('just now');
	});

	it('shows minutes, hours, and days', () => {
		expect(formatRelative(ago(5 * 60), NOW)).toBe('5m ago');
		expect(formatRelative(ago(2 * 3600), NOW)).toBe('2h ago');
		expect(formatRelative(ago(3 * 86400), NOW)).toBe('3d ago');
	});

	it('returns an empty string for an unparseable input', () => {
		expect(formatRelative('not-a-date', NOW)).toBe('');
	});
});

describe('formatDuration', () => {
	it('formats sub-minute, minutes, hours, and days with at most two units', () => {
		expect(formatDuration(ago(45), NOW)).toBe('45s');
		expect(formatDuration(ago(12 * 60), NOW)).toBe('12m');
		expect(formatDuration(ago(2 * 3600 + 14 * 60), NOW)).toBe('2h 14m');
		expect(formatDuration(ago(86400 + 3 * 3600), NOW)).toBe('1d 3h');
	});

	it('clamps negative spans to 0s', () => {
		expect(formatDuration(ago(-10), NOW)).toBe('0s');
	});

	it('returns an empty string for an unparseable input', () => {
		expect(formatDuration('nope', NOW)).toBe('');
	});
});
