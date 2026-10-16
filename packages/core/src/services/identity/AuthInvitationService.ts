import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import type { UserId } from '../../ids';
import { UserIdSchema, EmailAddressSchema, readStored } from '../../schema';
import { normalizeEmail } from '../../identityMatch';
import { paths } from '../../paths';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { listAllKeys } from '../catalog/storage';
import { withCasRetry } from '../catalog/cas';

export const AuthInvitationEmailSchema = z
	.string()
	.transform(normalizeEmail)
	.pipe(EmailAddressSchema);

export const AuthInvitationSchema = z.object({
	email: EmailAddressSchema,
	created_at: z.iso.datetime(),
	created_by: UserIdSchema,
});

export class AuthInvitationService {
	constructor(private readonly bucket: Bucket) {}

	async get(email: string) {
		const normalized = AuthInvitationEmailSchema.parse(email);
		const key = paths.authInvitation(normalized);
		const obj = await this.bucket.get(key);
		if (!obj) return null;
		const record = await readStored(AuthInvitationSchema, obj, key);
		return record.email === normalized ? record : null;
	}

	async invite(email: string, actor: UserId) {
		const normalized = AuthInvitationEmailSchema.parse(email);
		return withCasRetry(this.bucket, async (cas) => {
			const existing = await this.get(normalized);
			if (existing) return existing;
			const record = AuthInvitationSchema.parse({
				email: normalized,
				created_at: new Date().toISOString(),
				created_by: actor,
			});
			await cas.put(paths.authInvitation(normalized), JSON.stringify(record), {
				onlyIfNotExists: true,
			});
			return record;
		});
	}

	async revoke(email: string): Promise<void> {
		await this.bucket.delete(paths.authInvitation(AuthInvitationEmailSchema.parse(email)));
	}

	async list() {
		const keys = await listAllKeys(this.bucket, paths.authInvitationsPrefix);
		const records = await mapWithConcurrency(keys, BUCKET_SCAN_CONCURRENCY, async (key) => {
			const obj = await this.bucket.get(key);
			return obj ? readStored(AuthInvitationSchema, obj, key) : null;
		});
		return records
			.filter((record) => record !== null)
			.sort((a, b) => a.email.localeCompare(b.email));
	}
}
