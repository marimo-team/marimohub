import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import type { SandboxId, UserId } from '../../ids';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import { parseStored, readStored, readStoredJson, SandboxIdSchema } from '../../schema';
import { listAllKeys } from '../catalog/storage';
import { releaseSingletonClaim, withCasRetry } from '../catalog/cas';

const SandboxDiagnosticLeaseSchema = z
	.object({
		sandbox_id: SandboxIdSchema.nullable(),
		expires_at: z.iso.datetime().nullable(),
	})
	.refine(
		(record) => (record.sandbox_id === null) === (record.expires_at === null),
		'The sandbox id and expiration must both be set or both be null',
	);

type SandboxDiagnosticLeaseRecord = z.infer<typeof SandboxDiagnosticLeaseSchema>;

const releasedRecord = (): SandboxDiagnosticLeaseRecord => ({
	sandbox_id: null,
	expires_at: null,
});

export class SandboxDiagnosticLease {
	constructor(private bucket: Bucket) {}

	async acquire(userId: UserId, sandboxId: SandboxId, ttlMs: number): Promise<boolean> {
		const key = paths.sandboxDiagnosticLease(userId);
		const now = Date.now();
		const body = JSON.stringify({
			sandbox_id: sandboxId,
			expires_at: new Date(now + ttlMs).toISOString(),
		} satisfies SandboxDiagnosticLeaseRecord);

		return withCasRetry(this.bucket, async (cas) => {
			const existing = await this.bucket.get(key);
			if (!existing) {
				await cas.put(key, body, { onlyIfNotExists: true });
				return true;
			}

			let current: SandboxDiagnosticLeaseRecord | undefined;
			try {
				current = parseStored(
					SandboxDiagnosticLeaseSchema,
					await readStoredJson(existing, key),
					key,
				);
			} catch (error) {
				logOperationalError(
					'corrupt_sandbox_diagnostic_lease_replaced',
					{ operation: 'sandbox_diagnostic_lease.acquire', object: key },
					error,
				);
			}
			if (
				current &&
				current.sandbox_id !== null &&
				current.expires_at !== null &&
				Date.parse(current.expires_at) > now
			) {
				return false;
			}

			await cas.put(key, body, { onlyIfEtagMatches: existing.etag });
			return true;
		});
	}

	async release(userId: UserId, sandboxId: SandboxId): Promise<void> {
		const key = paths.sandboxDiagnosticLease(userId);
		await releaseSingletonClaim(
			{
				bucket: this.bucket,
				key,
				serialize: () => JSON.stringify(releasedRecord()),
				parseHolder: (raw) => parseStored(SandboxDiagnosticLeaseSchema, raw, key).sandbox_id,
			},
			sandboxId,
		);
	}

	async activeSandboxIds(now = Date.now()): Promise<Set<SandboxId>> {
		const active = new Set<SandboxId>();
		const keys = await listAllKeys(this.bucket, paths.sandboxDiagnosticLeasesPrefix);
		for (const key of keys) {
			const object = await this.bucket.get(key);
			if (!object) continue;
			try {
				const record = await readStored(SandboxDiagnosticLeaseSchema, object, key);
				if (
					record.sandbox_id !== null &&
					record.expires_at !== null &&
					Date.parse(record.expires_at) > now
				) {
					active.add(record.sandbox_id);
				}
			} catch (error) {
				logOperationalError(
					'corrupt_sandbox_diagnostic_lease_ignored',
					{ operation: 'sandbox_diagnostic_lease.list', object: key },
					error,
				);
			}
		}
		return active;
	}
}
