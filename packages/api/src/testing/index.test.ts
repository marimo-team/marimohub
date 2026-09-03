import { describe, expect, it } from 'vitest';
import { DEFAULT_JOBS_CONFIG } from '../context';
import { makeTestDeps } from './index';
import { MemoryBucket } from '@marimo-hub/core/testing';

describe('makeTestDeps', () => {
	it('clones the default jobs config for each dependency bundle', () => {
		const first = makeTestDeps(new MemoryBucket());
		const second = makeTestDeps(new MemoryBucket());

		first.jobs!.maxConcurrentRuns = 99;

		expect(second.jobs?.maxConcurrentRuns).toBe(DEFAULT_JOBS_CONFIG.maxConcurrentRuns);
		expect(DEFAULT_JOBS_CONFIG.maxConcurrentRuns).toBe(5);
	});
});
