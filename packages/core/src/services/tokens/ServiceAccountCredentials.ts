import { z } from 'zod';
import { UserId } from '../../ids';
import { toHex } from '../../internal/hex';
import { timingSafeEqual } from '../../internal/hmac';
import { sha256Hex } from '../../internal/sha256';
import type { AuthenticatedPrincipal } from '../../ports/auth';
import { SERVICE_ACCOUNT_ACTIONS } from '../../tokenGrants';

export const SERVICE_ACCOUNT_PREFIX = 'mhub_sa_';
export const SERVICE_ACCOUNT_USER_PREFIX = 'service-account:';

const AccountIdSchema = z
	.string()
	.regex(
		/^[a-z][a-z0-9-]{0,63}$/,
		'Use 1–64 lowercase letters, digits, or hyphens, starting with a letter',
	);
const CredentialSchema = z.strictObject({
	id: AccountIdSchema,
	sha256: z
		.string()
		.regex(/^[0-9a-f]{64}$/, 'Expected the lowercase SHA-256 hex digest of the complete token'),
	expires_at: z.iso
		.datetime({ error: 'Expected a UTC timestamp, for example 2027-01-01T00:00:00Z' })
		.optional(),
});
const AccountSchema = z.strictObject({
	id: AccountIdSchema,
	name: z.string().trim().min(1).max(100).optional(),
	actions: z
		.array(z.enum(SERVICE_ACCOUNT_ACTIONS))
		.min(1)
		.refine((actions) => new Set(actions).size === actions.length, 'Actions must be unique')
		.meta({ uniqueItems: true }),
	credentials: z.array(CredentialSchema).min(1).max(4),
});

export const ServiceAccountsConfigSchema = z
	.array(AccountSchema)
	.max(32)
	.superRefine((accounts, ctx) => {
		const ids = new Set<string>();
		const hashes = new Set<string>();
		for (const [index, account] of accounts.entries()) {
			if (ids.has(account.id)) {
				ctx.addIssue({
					code: 'custom',
					path: [index, 'id'],
					message: 'Account IDs must be unique',
				});
			}
			ids.add(account.id);
			const credentialIds = new Set<string>();
			for (const [credentialIndex, credential] of account.credentials.entries()) {
				if (credentialIds.has(credential.id)) {
					ctx.addIssue({
						code: 'custom',
						path: [index, 'credentials', credentialIndex, 'id'],
						message: 'Credential IDs must be unique within an account',
					});
				}
				credentialIds.add(credential.id);
				if (hashes.has(credential.sha256)) {
					ctx.addIssue({
						code: 'custom',
						path: [index, 'credentials', credentialIndex, 'sha256'],
						message: 'Credential hashes must be unique',
					});
				}
				hashes.add(credential.sha256);
			}
		}
	});

export type ServiceAccountsConfig = z.infer<typeof ServiceAccountsConfigSchema>;
type Account = ServiceAccountsConfig[number];
type Credential = Account['credentials'][number];

export async function generateServiceAccountToken(
	accountId: string,
	credentialId: string,
): Promise<{
	token: string;
	credential: Credential;
}> {
	AccountIdSchema.parse(accountId);
	AccountIdSchema.parse(credentialId);
	const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
	const token = `${SERVICE_ACCOUNT_PREFIX}${accountId}_${credentialId}_${secret}`;
	return { token, credential: { id: credentialId, sha256: await sha256Hex(token) } };
}

export class ServiceAccountCredentials {
	private readonly credentials = new Map<string, { account: Account; credential: Credential }>();

	constructor(config: ServiceAccountsConfig) {
		for (const account of ServiceAccountsConfigSchema.parse(config)) {
			for (const credential of account.credentials) {
				this.credentials.set(`${account.id}/${credential.id}`, { account, credential });
			}
		}
	}

	async verify(bearer: string): Promise<AuthenticatedPrincipal | null> {
		if (!bearer.startsWith(SERVICE_ACCOUNT_PREFIX) || bearer.length > 202) return null;
		const parts = bearer.slice(SERVICE_ACCOUNT_PREFIX.length).split('_');
		if (parts.length !== 3 || !/^[0-9a-f]{64}$/.test(parts[2])) return null;
		const id = `${parts[0]}/${parts[1]}`;
		const entry = this.credentials.get(id);
		if (!entry) return null;
		const { account, credential } = entry;
		const encoder = new TextEncoder();
		if (
			!timingSafeEqual(encoder.encode(await sha256Hex(bearer)), encoder.encode(credential.sha256))
		) {
			return null;
		}
		if (credential.expires_at !== undefined && Date.parse(credential.expires_at) <= Date.now())
			return null;
		return {
			id: UserId.parse(`${SERVICE_ACCOUNT_USER_PREFIX}${account.id}`),
			email: `${account.id}@service-accounts.invalid`,
			name: account.name ?? account.id,
			credential: {
				kind: 'service-account',
				id,
				grant: { actions: [...account.actions], projects: '*' },
				...(credential.expires_at === undefined ? {} : { expiresAt: credential.expires_at }),
			},
		};
	}
}
