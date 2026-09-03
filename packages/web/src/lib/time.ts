// Lightweight relative-time + duration formatting. No date library: the inputs
// are ISO datetime strings from the API and the outputs are short, human labels
// for attribution UI ("2h ago", "1d 3h").

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Format an ISO timestamp as a compact relative phrase ("just now", "5m ago",
 * "2h ago", "3d ago"). `now` is injectable for deterministic tests. Falls back
 * to a locale date for anything older than ~30 days, and returns an empty string
 * for an unparseable input.
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return '';

	const secs = Math.round((now - then) / 1000);
	if (secs < 0) return 'just now';
	if (secs < 45) return 'just now';
	if (secs < HOUR) return `${Math.round(secs / MINUTE)}m ago`;
	if (secs < DAY) return `${Math.round(secs / HOUR)}h ago`;
	if (secs < 30 * DAY) return `${Math.round(secs / DAY)}d ago`;
	return new Date(then).toLocaleDateString();
}

/**
 * Format the elapsed span from `iso` to `now` as a compact duration
 * ("0s", "45s", "12m", "2h 14m", "1d 3h"). Shows at most two units. `now` is
 * injectable for deterministic tests / live ticking. Empty string for an
 * unparseable input.
 */
export function formatDuration(iso: string, now: number = Date.now()): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return '';
	return formatElapsed(now - then);
}

/** Format a millisecond span the same way (`"45s"`, `"12m"`, `"2h 14m"`); negatives read as zero. */
export function formatElapsed(ms: number): string {
	let secs = Math.max(0, Math.floor(ms / 1000));
	if (secs < MINUTE) return `${secs}s`;

	const days = Math.floor(secs / DAY);
	secs -= days * DAY;
	const hours = Math.floor(secs / HOUR);
	secs -= hours * HOUR;
	const mins = Math.floor(secs / MINUTE);

	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	return `${mins}m`;
}

/** A locale date-time for tooltips and run timestamps; an em dash when absent or unparseable. */
export function formatAbsolute(iso: string | undefined): string {
	if (!iso) return '—';
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
