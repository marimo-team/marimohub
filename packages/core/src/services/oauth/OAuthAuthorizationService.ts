import { z } from 'zod';
import type { Bucket, BucketObjectBody } from '../../ports/bucket';
import { BadRequestError, PreconditionFailedError } from '../../errors';
import { createOAuthAuthorizationId, OAuthAuthorizationId } from '../../ids';
import type { UserId } from '../../ids';
import { timingSafeEqual } from '../../internal/hmac';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import { readStored, UserIdSchema } from '../../schema';
import { TokenGrantSchema } from '../../tokenGrants';
import type { TokenGrant } from '../../tokenGrants';
import type { CreatedToken, TokenService } from '../tokens/TokenService';
import {
	authorizationCreatedAt,
	createAuthorizationCode,
	hashAuthorizationSecret,
} from '../tokens/authorizationCodes';

const AUTHORIZATION_PREFIX = 'mhub_oac_';
const AUTHORIZATION_RE = /^mhub_oac_([0-9A-Z]{26})_([0-9a-z]{32})$/;
export const OAUTH_TOKEN_LIFETIME_DAYS_MAX = 90;

const AuthorizationCommonSchema = {
	id: z.string().refine(OAuthAuthorizationId.is),
	client_id: z.string().min(1),
	client_name: z.string().optional(),
	client_uri: z.string().optional(),
	redirect_uri: z.string(),
	code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	scopes: z.array(z.string()),
	state: z.string().optional(),
	resource: z.string().optional(),
	created_at: z.iso.datetime(),
	expires_at: z.iso.datetime(),
};

const PendingAuthorizationSchema = z.looseObject({
	...AuthorizationCommonSchema,
	status: z.literal('pending'),
});

const ApprovedAuthorizationSchema = z.looseObject({
	...AuthorizationCommonSchema,
	status: z.enum(['approved', 'claimed']),
	user_id: UserIdSchema,
	code_hash: z.string().regex(/^[0-9a-f]{64}$/),
	grant: TokenGrantSchema,
	token_name: z.string().min(1).max(100),
	expires_in_days: z.number().int().min(1).max(OAUTH_TOKEN_LIFETIME_DAYS_MAX),
});

const OAuthAuthorizationSchema = z.discriminatedUnion('status', [
	PendingAuthorizationSchema,
	ApprovedAuthorizationSchema,
]);

type OAuthAuthorization = z.infer<typeof OAuthAuthorizationSchema>;
type PendingAuthorization = z.infer<typeof PendingAuthorizationSchema>;
type ApprovedAuthorization = z.infer<typeof ApprovedAuthorizationSchema>;

export interface BeginOAuthAuthorizationInput {
	clientId: string;
	clientName?: string;
	clientUri?: string;
	redirectUri: string;
	codeChallenge: string;
	scopes: string[];
	state?: string;
	resource?: string;
}

function invalidAuthorization(): BadRequestError {
	return new BadRequestError('OAuth authorization code is invalid or expired');
}

async function readAuthorization(
	object: BucketObjectBody,
	key: string,
): Promise<OAuthAuthorization | null> {
	try {
		return await readStored(OAuthAuthorizationSchema, object, key);
	} catch (error) {
		logOperationalError(
			'stored_object_skipped',
			{ operation: 'oauth_authorization.read', object: key },
			error,
		);
		return null;
	}
}

function redirectWith(url: string, values: Record<string, string | undefined>): string {
	const redirect = new URL(url);
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) redirect.searchParams.set(key, value);
	}
	return redirect.toString();
}

export class OAuthAuthorizationService {
	static readonly AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
	static readonly PRUNE_LIMIT = 100;

	constructor(
		private bucket: Bucket,
		private tokens: TokenService,
	) {}

	async begin(input: BeginOAuthAuthorizationInput): Promise<{ id: OAuthAuthorizationId }> {
		await this.pruneExpired();
		const id = createOAuthAuthorizationId();
		const now = new Date();
		const record: PendingAuthorization = {
			id,
			client_id: input.clientId,
			redirect_uri: input.redirectUri,
			code_challenge: input.codeChallenge,
			scopes: input.scopes,
			created_at: now.toISOString(),
			expires_at: new Date(
				now.getTime() + OAuthAuthorizationService.AUTHORIZATION_TTL_MS,
			).toISOString(),
			status: 'pending',
			...(input.clientName ? { client_name: input.clientName } : {}),
			...(input.clientUri ? { client_uri: input.clientUri } : {}),
			...(input.state !== undefined ? { state: input.state } : {}),
			...(input.resource ? { resource: input.resource } : {}),
		};
		await this.bucket.put(paths.oauthAuthorization(id), JSON.stringify(record), {
			onlyIfNotExists: true,
		});
		return { id };
	}

	async preview(id: OAuthAuthorizationId) {
		const { record } = await this.readPending(id);
		return {
			clientName: record.client_name ?? 'MCP client',
			...(record.client_uri ? { clientUri: record.client_uri } : {}),
			redirectUri: record.redirect_uri,
			scopes: record.scopes,
			expiresAt: record.expires_at,
		};
	}

	async approve(
		id: OAuthAuthorizationId,
		input: { grant: TokenGrant; tokenName: string; expiresInDays: number },
		userId: UserId,
	): Promise<{ redirectUri: string }> {
		if (
			!Number.isInteger(input.expiresInDays) ||
			input.expiresInDays < 1 ||
			input.expiresInDays > OAUTH_TOKEN_LIFETIME_DAYS_MAX
		) {
			throw new BadRequestError(
				`OAuth token lifetime must be between 1 and ${OAUTH_TOKEN_LIFETIME_DAYS_MAX} days`,
			);
		}
		const { key, object, record } = await this.readPending(id);
		const created = await createAuthorizationCode(
			() => id,
			OAuthAuthorizationService.AUTHORIZATION_TTL_MS,
		);
		const approved: ApprovedAuthorization = {
			...record,
			status: 'approved',
			user_id: userId,
			code_hash: created.common.code_hash,
			grant: input.grant,
			token_name: input.tokenName,
			expires_in_days: input.expiresInDays,
		};
		try {
			await this.bucket.put(key, JSON.stringify(approved), { onlyIfEtagMatches: object.etag });
		} catch (error) {
			if (error instanceof PreconditionFailedError) throw invalidAuthorization();
			throw error;
		}
		return {
			redirectUri: redirectWith(record.redirect_uri, {
				code: `${AUTHORIZATION_PREFIX}${id}_${created.secret}`,
				state: record.state,
			}),
		};
	}

	async deny(id: OAuthAuthorizationId): Promise<{ redirectUri: string }> {
		const { key, record } = await this.readPending(id);
		await this.bucket.delete(key);
		return {
			redirectUri: redirectWith(record.redirect_uri, {
				error: 'access_denied',
				state: record.state,
			}),
		};
	}

	async challengeFor(code: string, clientId: string): Promise<string> {
		const { record } = await this.readPresented(code);
		if (record.client_id !== clientId) throw invalidAuthorization();
		return record.code_challenge;
	}

	async exchange(input: {
		code: string;
		clientId: string;
		redirectUri?: string;
		resource?: string;
	}): Promise<CreatedToken> {
		const { key, object, record } = await this.readPresented(input.code);
		if (
			record.client_id !== input.clientId ||
			record.redirect_uri !== input.redirectUri ||
			(record.resource ?? undefined) !== (input.resource ?? undefined)
		) {
			throw invalidAuthorization();
		}
		try {
			await this.bucket.put(key, JSON.stringify({ ...record, status: 'claimed' }), {
				onlyIfEtagMatches: object.etag,
			});
		} catch (error) {
			if (error instanceof PreconditionFailedError) throw invalidAuthorization();
			throw error;
		}
		try {
			return await this.tokens.create(
				{
					name: record.token_name,
					expiresInDays: record.expires_in_days,
					grant: record.grant,
					...(record.resource
						? {
								oauth: {
									clientId: record.client_id,
									resource: record.resource,
									scopes: record.scopes,
								},
							}
						: {}),
				},
				record.user_id,
			);
		} finally {
			try {
				await this.bucket.delete(key);
			} catch (error) {
				logOperationalError(
					'oauth_authorization_cleanup_failed',
					{ operation: 'oauth_authorization.exchange', object: key },
					error,
				);
			}
		}
	}

	private async readPending(id: OAuthAuthorizationId) {
		const key = paths.oauthAuthorization(id);
		const object = await this.bucket.get(key);
		if (!object) throw invalidAuthorization();
		const record = await readAuthorization(object, key);
		if (record?.status !== 'pending' || new Date(record.expires_at).getTime() <= Date.now()) {
			throw invalidAuthorization();
		}
		return { key, object, record };
	}

	private async readPresented(code: string) {
		const match = AUTHORIZATION_RE.exec(code);
		if (!match) throw invalidAuthorization();
		const id = OAuthAuthorizationId.parse(match[1]);
		const key = paths.oauthAuthorization(id);
		const object = await this.bucket.get(key);
		if (!object) throw invalidAuthorization();
		const record = await readAuthorization(object, key);
		if (record?.status !== 'approved' || new Date(record.expires_at).getTime() <= Date.now()) {
			throw invalidAuthorization();
		}
		const encoder = new TextEncoder();
		if (
			!timingSafeEqual(
				encoder.encode(await hashAuthorizationSecret(match[2])),
				encoder.encode(record.code_hash),
			)
		) {
			throw invalidAuthorization();
		}
		return { key, object, record };
	}

	private async pruneExpired(): Promise<void> {
		const page = await this.bucket.list({
			prefix: paths.oauthAuthorizationsPrefix,
			limit: OAuthAuthorizationService.PRUNE_LIMIT,
		});
		const now = Date.now();
		const expired = page.objects
			.filter((entry) => {
				const createdAt = authorizationCreatedAt(
					entry.key,
					paths.oauthAuthorizationsPrefix,
					OAuthAuthorizationId.is,
				);
				return (
					createdAt === null || createdAt + OAuthAuthorizationService.AUTHORIZATION_TTL_MS <= now
				);
			})
			.map((entry) => entry.key);
		if (expired.length > 0) await this.bucket.delete(expired);
	}
}
