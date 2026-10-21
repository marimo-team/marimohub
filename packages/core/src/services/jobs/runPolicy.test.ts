import { expect, it } from 'vitest';
import { Millis } from '../../duration';
import { jobTimeoutSeconds } from './runPolicy';

it('derives the run timeout from the job under the deployment ceiling', () => {
	const config = { defaultTimeoutMs: Millis.minutes(30), maxTimeoutMs: Millis.hours(4) };
	expect(jobTimeoutSeconds({}, config)).toBe(1800);
	expect(jobTimeoutSeconds({ timeout_seconds: 600 }, config)).toBe(600);
	expect(jobTimeoutSeconds({ timeout_seconds: 99_999 }, config)).toBe(14_400);
});
