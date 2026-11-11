import { afterEach, expect, test, vi } from 'vitest';
import type { Session } from '@marimo-hub/core';
import { seed } from './seed';

afterEach(() => vi.useRealTimers());

test.each([1, 5, 200])('terminal fixture distribution and ages with %i projects', async (count) => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
	const fixture = await seed(count, 2, { terminalSessions: 2000 });
	const sessions: Session[] = [];
	let cursor: string | undefined;
	do {
		const page = await fixture.bucket.list({ prefix: '_system/sessions/', cursor });
		for (const object of page.objects) {
			sessions.push(await (await fixture.bucket.get(object.key))!.json<Session>());
		}
		cursor = page.cursor;
	} while (cursor);
	const terminal = sessions.filter((session) => session.sandbox_reclaimed_at);
	expect(terminal).toHaveLength(2000);
	expect(sessions.filter((session) => session.status === 'running')).toHaveLength(5);
	const counts = fixture.projects.map(
		(project) => terminal.filter((session) => session.project_id === project.id).length,
	);
	expect(counts[0]).toBe(count === 1 ? 2000 : 200);
	if (count > 1) {
		expect(Math.max(...counts.slice(1)) - Math.min(...counts.slice(1))).toBeLessThanOrEqual(1);
	}
	for (const session of terminal) {
		const age = Date.now() - Date.parse(session.started_at);
		expect(age).toBeGreaterThanOrEqual(3_600_000);
		expect(age).toBeLessThan(86_400_000);
	}
});
