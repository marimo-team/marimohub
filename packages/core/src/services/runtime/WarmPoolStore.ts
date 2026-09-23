import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import type { SandboxId } from '../../ids';
import { listAllKeys } from '../catalog/storage';
import { paths } from '../../paths';
import {
	NotebookIdSchema,
	ProjectIdSchema,
	SandboxIdSchema,
	SessionIdSchema,
	readStored,
} from '../../schema';
import { withCasRetry } from '../catalog/cas';

const Timestamp = z.number().int().nonnegative();
export const WarmPoolMemberSchema = z.object({
	sandbox_id: SandboxIdSchema,
	state: z.enum(['creating', 'ready', 'claimed', 'retiring']),
	token: z.string(),
	created_at: Timestamp,
	ready_until: Timestamp,
	operation_until: Timestamp,
	checked_at: Timestamp,
	destination: z
		.object({
			project_id: ProjectIdSchema,
			notebook_id: NotebookIdSchema,
			session_id: SessionIdSchema,
		})
		.optional(),
	assigned: z.boolean(),
});
export type WarmPoolMember = z.infer<typeof WarmPoolMemberSchema>;
export const WarmPoolRecordSchema = z.object({
	pools: z.array(
		z.object({
			key: z.string(),
			failures: z.number().int().nonnegative(),
			retry_at: Timestamp,
			members: z.array(WarmPoolMemberSchema),
		}),
	),
});
export type WarmPoolRecord = z.infer<typeof WarmPoolRecordSchema>;

export function getOrCreateWarmPool(record: WarmPoolRecord, key: string) {
	let pool = record.pools.find((item) => item.key === key);
	if (!pool) {
		pool = { key, failures: 0, retry_at: 0, members: [] };
		record.pools.push(pool);
	}
	return pool;
}

function findMember(record: WarmPoolRecord, id: SandboxId) {
	return record.pools.flatMap((pool) => pool.members).find((member) => member.sandbox_id === id);
}

function ownedIds(record: WarmPoolRecord) {
	return record.pools.flatMap((pool) => pool.members.map((member) => member.sandbox_id));
}

export class WarmPoolStore {
	constructor(
		private readonly bucket: Bucket,
		readonly backend: string,
	) {}

	async read(): Promise<WarmPoolRecord> {
		const key = paths.warmPool(this.backend);
		const object = await this.bucket.get(key);
		return object ? readStored(WarmPoolRecordSchema, object, key) : { pools: [] };
	}

	async mutate<T>(update: (record: WarmPoolRecord) => T): Promise<T> {
		const key = paths.warmPool(this.backend);
		return withCasRetry(this.bucket, async (writer) => {
			const object = await this.bucket.get(key);
			const record = object ? await readStored(WarmPoolRecordSchema, object, key) : { pools: [] };
			const before = JSON.stringify(record);
			const result = update(record);
			const after = JSON.stringify(record);
			if (before !== after) {
				await writer.put(
					key,
					after,
					object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
				);
			}
			return result;
		});
	}

	async ownedSandboxIds(): Promise<Set<string>> {
		return new Set(ownedIds(await this.read()));
	}

	static async allOwnedSandboxIds(bucket: Bucket): Promise<Set<string>> {
		const ids = new Set<string>();
		for (const key of await listAllKeys(bucket, paths.warmPoolsPrefix)) {
			const object = await bucket.get(key);
			// Ownership records are retained. A missing listed record is not proof of an orphan.
			if (!object) throw new Error(`Warm pool ownership unavailable: ${key}`);
			for (const id of ownedIds(await readStored(WarmPoolRecordSchema, object, key))) ids.add(id);
		}
		return ids;
	}

	async getMember(id: SandboxId): Promise<WarmPoolMember | undefined> {
		return findMember(await this.read(), id);
	}

	updateMember(
		member: WarmPoolMember,
		state: WarmPoolMember['state'],
		apply: (current: WarmPoolMember) => void | false,
	): Promise<boolean> {
		return this.mutate((record) => {
			const current = findMember(record, member.sandbox_id);
			if (!current || current.state !== state || current.token !== member.token) return false;
			return apply(current) !== false;
		});
	}

	removeMember(member: WarmPoolMember): Promise<void> {
		return this.mutate((record) => {
			for (const pool of record.pools) {
				pool.members = pool.members.filter(
					(item) => item.sandbox_id !== member.sandbox_id || item.token !== member.token,
				);
			}
		});
	}
}
