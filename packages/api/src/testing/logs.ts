import { vi } from 'vitest';

export function captureLogEvents(event: string) {
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	return {
		events: () =>
			log.mock.calls
				.filter(([line]) => typeof line === 'string' && line.startsWith('{'))
				.map(([line]) => JSON.parse(line) as Record<string, unknown>)
				.filter((entry) => entry.event === event),
		restore: () => log.mockRestore(),
	};
}
