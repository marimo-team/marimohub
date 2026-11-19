import { afterEach, expect, it, vi } from 'vitest';
import { createSandboxId } from '@marimo-hub/core';
import { sessionStartupReporter } from './sessionStartup';

afterEach(() => vi.useRealTimers());

it('captures occurrence time, deduplicates updates, and fences replaced attempts', () => {
	vi.useFakeTimers();
	const emit = vi.fn();
	const reporter = sessionStartupReporter(emit);
	const originalId = createSandboxId();
	const first = reporter.forSandbox(originalId);
	const at = new Date().toISOString();
	first({ phase: 'allocating', detail: 'Queued' });
	vi.advanceTimersByTime(5000);
	first({ phase: 'allocating', detail: 'Pulling image' });
	expect(emit).toHaveBeenLastCalledWith(
		{
			phase: 'allocating',
			detail: 'Pulling image',
			started_at: at,
			attempt: 1,
			observed: ['allocating'],
		},
		originalId,
	);
	first({ phase: 'allocating', detail: 'Pulling image' });
	expect(emit).toHaveBeenCalledTimes(2);
	first({ phase: 'starting' });
	expect(emit.mock.lastCall?.[0].observed).toEqual(['allocating', 'starting']);
	first({ phase: 'workspace' });
	expect(emit).toHaveBeenCalledTimes(3);
	const next = reporter.forSandbox(createSandboxId());
	next({ phase: 'workspace', detail: 'x'.repeat(300) });
	first({ phase: 'starting', detail: 'Late callback' });
	expect(emit.mock.lastCall?.[0]).toMatchObject({
		attempt: 2,
		observed: ['workspace'],
		detail: 'x'.repeat(240),
	});
	reporter.close();
	next({ phase: 'starting' });
	expect(emit).toHaveBeenCalledTimes(4);
});

it('does not propagate observer failures', () => {
	const reporter = sessionStartupReporter(() => {
		throw new Error('observer unavailable');
	});
	expect(() => reporter.forSandbox(createSandboxId())({ phase: 'allocating' })).not.toThrow();
});

it('keeps callback identity while a replacement is being prepared', () => {
	const emit = vi.fn();
	const reporter = sessionStartupReporter(emit);
	const originalId = createSandboxId();
	const original = reporter.forSandbox(originalId);
	original({ phase: 'allocating' });
	const replacementId = createSandboxId();
	original({ phase: 'workspace' });
	expect(emit.mock.lastCall?.[1]).toBe(originalId);
	const replacement = reporter.forSandbox(replacementId);
	replacement({ phase: 'allocating' });
	original({ phase: 'starting' });
	expect(emit).toHaveBeenCalledTimes(3);
	expect(emit.mock.lastCall?.[1]).toBe(replacementId);
});
