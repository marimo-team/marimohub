import { expect, it, vi } from 'vitest';
import { createSandboxId } from '@marimo-hub/core/ids';
import { durableStartup } from './durableStartup';

const progress = {
	sandbox_id: createSandboxId(),
	phase: 'allocating' as const,
	attempt: 1,
	started_at: new Date().toISOString(),
	observed: ['allocating' as const],
};

function fixture(persist = vi.fn().mockResolvedValue(undefined)) {
	const tasks: (() => Promise<void>)[] = [];
	const reporter = durableStartup(persist, (task) => tasks.push(task));
	return { persist, tasks, reporter, run: () => tasks.shift()!() };
}

it('coalesces reports before admission and while a host task is queued', async () => {
	const { reporter, tasks, persist, run } = fixture();
	reporter.report(progress);
	expect(tasks).toHaveLength(0);
	reporter.enable();
	reporter.report({ ...progress, phase: 'workspace' });
	reporter.report({ ...progress, phase: 'starting' });
	expect(tasks).toHaveLength(1);
	expect(persist).not.toHaveBeenCalled();
	await run();
	expect(persist).toHaveBeenCalledTimes(1);
	expect(persist.mock.lastCall?.[0].phase).toBe('starting');
});

it('keeps only one pending report while storage is stalled', async () => {
	const gate = Promise.withResolvers<void>();
	const { reporter, tasks, persist, run } = fixture(
		vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined),
	);
	reporter.enable();
	reporter.report(progress);
	const writing = run();
	reporter.report({ ...progress, phase: 'workspace' });
	const final = { ...progress, phase: 'starting' as const };
	reporter.report(final);
	expect(tasks).toHaveLength(0);
	gate.resolve();
	await writing;
	expect(persist.mock.calls.map(([value]) => value)).toEqual([progress, final]);
});

it('returns final progress immediately and cancels queued writes', async () => {
	const { reporter, persist, run } = fixture();
	reporter.enable();
	reporter.report(progress);
	expect(reporter.finish()).toEqual(progress);
	await run();
	expect(persist).not.toHaveBeenCalled();
	expect(reporter.hasWrites).toBe(false);
	reporter.enable();
	reporter.report({ ...progress, phase: 'workspace' });
	expect(reporter.finish()).toEqual(progress);
});

it.each(['resolve', 'reject'] as const)(
	'does not wait for an in-flight write that will %s',
	async (outcome) => {
		const gate = Promise.withResolvers<void>();
		const { reporter, persist, run } = fixture(vi.fn().mockReturnValue(gate.promise));
		reporter.enable();
		reporter.report(progress);
		const writing = run();
		const final = { ...progress, phase: 'starting' as const };
		reporter.report(final);
		expect(reporter.finish()).toEqual(final);
		expect(reporter.hasWrites).toBe(true);
		if (outcome === 'reject') {
			const rejected = expect(writing).rejects.toThrow('Unavailable');
			gate.reject(new Error('Unavailable'));
			await rejected;
		} else {
			gate.resolve();
			await writing;
		}
		expect(reporter.finish()).toEqual(final);
		expect(persist).toHaveBeenCalledTimes(1);
	},
);

it('stops intermediate writes after failure but retains the latest phase for publication', async () => {
	const { reporter, tasks, run } = fixture(vi.fn().mockRejectedValue(new Error('Unavailable')));
	reporter.enable();
	reporter.report(progress);
	await expect(run()).rejects.toThrow('Unavailable');
	const final = { ...progress, phase: 'starting' as const };
	reporter.report(final);
	expect(tasks).toHaveLength(0);
	expect(reporter.finish()).toEqual(final);
});

it('skips intermediate writes without a host lifetime', () => {
	const persist = vi.fn();
	const reporter = durableStartup(persist);
	reporter.enable();
	reporter.report(progress);
	expect(reporter.finish()).toEqual(progress);
	expect(persist).not.toHaveBeenCalled();
	expect(reporter.hasWrites).toBe(false);
});

it('skips detail-only updates but persists replacement attempts', async () => {
	const { reporter, tasks, persist, run } = fixture();
	reporter.enable();
	reporter.report(progress);
	await run();
	reporter.report({ ...progress, detail: 'More detail' });
	expect(tasks).toHaveLength(0);
	const replacement = { ...progress, sandbox_id: createSandboxId(), attempt: 2 };
	reporter.report(replacement);
	await run();
	expect(persist.mock.calls.map(([value]) => value)).toEqual([progress, replacement]);
});
