import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import type { ProjectId, UserId } from '../../ids';
import { paths } from '../../paths';
import { readStored } from '../../schema';
import { withCasRetry } from '../catalog/cas';

/** A remembered "always allow" consent for one tool scope, private to the user and project. */
export const ChatPermissionGrantSchema = z.object({
	id: z.uuid(),
	kind: z.string().min(1).max(40),
	scope_key: z.string().min(1).max(200),
	scope_label: z.string().max(120),
	action: z.string().max(120),
	created_at: z.iso.datetime(),
});
export type ChatPermissionGrant = z.infer<typeof ChatPermissionGrantSchema>;

export const ChatPermissionRecordSchema = z.object({
	schema_version: z.literal(1),
	grants: z.array(ChatPermissionGrantSchema).max(200),
});

export class ChatPermissionStore {
	constructor(private readonly bucket: Bucket) {}

	async list(pid: ProjectId, user: UserId): Promise<ChatPermissionGrant[]> {
		const key = paths.chatPermissions(pid, user);
		const object = await this.bucket.get(key);
		return object ? (await readStored(ChatPermissionRecordSchema, object, key)).grants : [];
	}

	async find(pid: ProjectId, user: UserId, kind: string, scopeKey: string) {
		return (await this.list(pid, user)).find(
			(grant) => grant.kind === kind && grant.scope_key === scopeKey,
		);
	}

	async grant(
		pid: ProjectId,
		user: UserId,
		input: Omit<ChatPermissionGrant, 'id' | 'created_at'>,
	): Promise<ChatPermissionGrant> {
		const grant = ChatPermissionGrantSchema.parse({
			...input,
			id: crypto.randomUUID(),
			created_at: new Date().toISOString(),
		});
		await this.mutate(pid, user, (grants) =>
			[
				...grants.filter((item) => item.kind !== grant.kind || item.scope_key !== grant.scope_key),
				grant,
			].slice(-200),
		);
		return grant;
	}

	async revoke(pid: ProjectId, user: UserId, grantId: string): Promise<boolean> {
		let removed = false;
		await this.mutate(pid, user, (grants) => {
			removed = grants.some((grant) => grant.id === grantId);
			return grants.filter((grant) => grant.id !== grantId);
		});
		return removed;
	}

	private async mutate(
		pid: ProjectId,
		user: UserId,
		apply: (grants: ChatPermissionGrant[]) => ChatPermissionGrant[],
	): Promise<void> {
		const key = paths.chatPermissions(pid, user);
		await withCasRetry(this.bucket, async (cas) => {
			const object = await this.bucket.get(key);
			const grants = object
				? (await readStored(ChatPermissionRecordSchema, object, key)).grants
				: [];
			const next = ChatPermissionRecordSchema.parse({ schema_version: 1, grants: apply(grants) });
			await cas.put(
				key,
				JSON.stringify(next),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
		});
	}
}
