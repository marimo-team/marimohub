import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandboxId } from '../../ids';
import { paths } from '../../paths';
import { ACTOR, MemoryBucket, uid, useFakeClock } from '../../testing';
import { SandboxDiagnosticLease } from './SandboxDiagnosticLease';

describe('SandboxDiagnosticLease', () => {
	let bucket: MemoryBucket;
	let leases: SandboxDiagnosticLease;
	let clock: ReturnType<typeof useFakeClock>;

	beforeEach(() => {
		clock = useFakeClock(0);
		bucket = new MemoryBucket();
		leases = new SandboxDiagnosticLease(bucket);
	});

	afterEach(() => {
		clock.restore();
	});

	it('serializes one live diagnostic per user while allowing other users', async () => {
		const first = createSandboxId();
		const second = createSandboxId();

		expect(await leases.acquire(ACTOR, first, 10_000)).toBe(true);
		expect(await new SandboxDiagnosticLease(bucket).acquire(ACTOR, second, 10_000)).toBe(false);
		expect(await leases.acquire(uid('another-admin'), second, 10_000)).toBe(true);
		expect(await leases.activeSandboxIds()).toEqual(new Set([first, second]));
	});

	it('releases only the matching holder and permits a later run', async () => {
		const first = createSandboxId();
		const second = createSandboxId();
		await leases.acquire(ACTOR, first, 1_000);
		clock.set(2_000);
		expect(await leases.acquire(ACTOR, second, 10_000)).toBe(true);

		await leases.release(ACTOR, first);
		expect(await leases.activeSandboxIds()).toEqual(new Set([second]));
		await leases.release(ACTOR, second);

		expect(await leases.activeSandboxIds()).toEqual(new Set());
		expect(await (await bucket.get(paths.sandboxDiagnosticLease(ACTOR)))!.json()).toEqual({
			sandbox_id: null,
			expires_at: null,
		});
	});

	it('expires a leaked lease so admission and reconciliation recover after a crash', async () => {
		const first = createSandboxId();
		const second = createSandboxId();
		await leases.acquire(ACTOR, first, 1_000);
		clock.set(2_000);

		expect(await leases.activeSandboxIds()).toEqual(new Set());
		expect(await leases.acquire(ACTOR, second, 10_000)).toBe(true);
		expect(await leases.activeSandboxIds()).toEqual(new Set([second]));
	});
});
