import { describe, it, expect } from 'vitest';
import { runPreflight } from './preflight';
import type { PreflightCheck } from './preflight';

const check = (name: string, run: PreflightCheck['run']): PreflightCheck => ({ name, run });

describe('runPreflight', () => {
	it('aggregates ok results', async () => {
		const report = await runPreflight([
			check('a', async () => ({ status: 'ok', message: 'a ok' })),
			check('b', async () => ({ status: 'skipped', message: 'b skipped' })),
		]);
		expect(report.ok).toBe(true);
		expect(report.fatal).toBe(false);
		expect(report.checks.map((c) => c.name)).toEqual(['a', 'b']);
	});

	it('treats warn as ok-to-serve but fail as not-ok', async () => {
		const report = await runPreflight([
			check('a', async () => ({ status: 'warn', message: 'degraded' })),
			check('b', async () => ({ status: 'fail', message: 'down' })),
		]);
		expect(report.ok).toBe(false);
		expect(report.fatal).toBe(false);
	});

	it('flags fatal only when a check opts in', async () => {
		const report = await runPreflight([
			check('a', async () => ({ status: 'fail', message: 'unsafe', fatal: true })),
		]);
		expect(report.fatal).toBe(true);
	});

	it('converts a thrown check into a non-fatal fail', async () => {
		const report = await runPreflight([
			check('boom', async () => {
				throw new Error('kaboom');
			}),
		]);
		expect(report.checks[0]).toMatchObject({ name: 'boom', status: 'fail', message: 'kaboom' });
		expect(report.fatal).toBe(false);
	});

	it('times out a hanging check as a non-fatal fail without hanging the report', async () => {
		const report = await runPreflight(
			[
				check('hang', () => new Promise(() => {})),
				check('quick', async () => ({ status: 'ok', message: 'fine' })),
			],
			{ timeoutMs: 10 },
		);
		expect(report.checks.find((c) => c.name === 'hang')?.status).toBe('fail');
		expect(report.checks.find((c) => c.name === 'quick')?.status).toBe('ok');
		expect(report.fatal).toBe(false);
	});

	it('stamps latency', async () => {
		let t = 0;
		const report = await runPreflight([check('a', async () => ({ status: 'ok', message: 'ok' }))], {
			now: () => (t += 5),
		});
		expect(report.checks[0].latencyMs).toBe(5);
	});
});
