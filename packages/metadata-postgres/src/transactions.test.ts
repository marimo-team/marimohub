import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { guardedTransaction } from './transactions';

const identity = {
	namespace: 'test',
	epoch: 1,
	artifactStoreId: '11111111-1111-4111-8111-111111111111',
};

describe('transaction failure boundaries', () => {
	it('destroys the connection and does not retry an uncertain COMMIT', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql === 'COMMIT') throw new Error('lost reply');
		});
		const release = vi.fn();
		const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
		const work = vi.fn(async () => 'result');
		await expect(guardedTransaction(pool, identity, work)).rejects.toMatchObject({
			kind: 'commit-unknown',
		});
		expect(work).toHaveBeenCalledOnce();
		expect(query).not.toHaveBeenCalledWith('ROLLBACK');
		expect(release).toHaveBeenCalledWith(true);
	});
	it('rolls back before reusing a connection and discards driver detail', async () => {
		const query = vi.fn(async () => {});
		const release = vi.fn();
		const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
		const failure = guardedTransaction(pool, identity, async () => {
			throw Object.assign(new Error('private record bytes'), { code: '57014', detail: 'secret' });
		});
		await expect(failure).rejects.toMatchObject({ kind: 'unavailable', sqlState: '57014' });
		await expect(failure).rejects.not.toHaveProperty('detail');
		expect(query).toHaveBeenLastCalledWith('ROLLBACK');
		expect(release).toHaveBeenCalledWith(false);
	});
	it.each(['40001', '40P01'])(
		'distinguishes a known transaction abort at COMMIT (%s) from a lost reply',
		async (code) => {
			const query = vi.fn(async (sql: string) => {
				if (sql === 'COMMIT') throw Object.assign(new Error('aborted'), { code });
			});
			const release = vi.fn();
			const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
			const work = vi.fn(async () => 'result');
			await expect(guardedTransaction(pool, identity, work)).rejects.toMatchObject({
				kind: 'serialization',
				sqlState: code,
			});
			expect(work).toHaveBeenCalledOnce();
			expect(query).toHaveBeenLastCalledWith('ROLLBACK');
		},
	);

	it('destroys a connection if rollback fails', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql === 'ROLLBACK') throw new Error('disconnected');
		});
		const release = vi.fn();
		const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
		await expect(
			guardedTransaction(pool, identity, async () => {
				throw new Error('failed');
			}),
		).rejects.toMatchObject({ kind: 'unavailable' });
		expect(release).toHaveBeenCalledWith(true);
	});
});
