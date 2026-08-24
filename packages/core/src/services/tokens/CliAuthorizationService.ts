import { z } from 'zod';
import { decodeTime } from 'ulidx';
import type { Bucket, BucketObjectBody } from '../../ports/bucket';
import { BadRequestError, PreconditionFailedError } from '../../errors';
import { CliAuthorizationId, createCliAuthorizationId } from '../../ids';
import type { UserId } from '../../ids';
import { toBase64Url } from '../../internal/base64url';
import { timingSafeEqual } from '../../internal/hmac';
import { toHex } from '../../internal/hex';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import { readStored, UserIdSchema } from '../../schema';
import type { CreatedToken, TokenService } from './TokenService';

const AUTHORIZATION_PREFIX = 'mhub_cli_';
const AUTHORIZATION_RE = /^mhub_cli_([0-9A-Z]{26})_([0-9a-z]{32})$/;
const SECRET_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const SECRET_LENGTH = 32;

const CliAuthorizationSchema = z.looseObject({
	id: z.string().refine(CliAuthorizationId.is),
	user_id: UserIdSchema,
	code_hash: z.string().regex(/^[0-9a-f]{64}$/),
	code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	token_name: z.string().min(1).max(100),
	expires_in_days: z.number().int().min(1).max(3650),
	created_at: z.iso.datetime(),
	expires_at: z.iso.datetime(),
	status: z.enum(['pending', 'claimed']),
});

type CliAuthorization = z.infer<typeof CliAuthorizationSchema>;

export interface ApproveCliAuthorizationInput {
	codeChallenge: string;
	tokenName: string;
	expiresInDays: number;
}

export interface ApprovedCliAuthorization {
	code: string;
	expiresAt: string;
}

function generateSecret(): string {
	const bytes = new Uint8Array(SECRET_LENGTH);
	crypto.getRandomValues(bytes);
	let secret = '';
	for (let i = 0; i < SECRET_LENGTH; i++) secret += SECRET_ALPHABET[bytes[i] & 31];
	return secret;
}

async function sha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function hash(value: string): Promise<string> {
	return toHex(await sha256(value));
}

async function readAuthorization(
	object: BucketObjectBody,
	key: string,
): Promise<CliAuthorization | null> {
	try {
		return await readStored(CliAuthorizationSchema, object, key);
	} catch (error) {
		logOperationalError(
			'stored_object_skipped',
			{ operation: 'cli_authorization.read', object: key },
			error,
		);
		return null;
	}
}

function invalidAuthorization(): BadRequestError {
	return new BadRequestError('CLI authorization code is invalid or expired');
}

function authorizationCreatedAt(key: string): number | null {
	if (!key.endsWith('.json')) return null;
	const encodedId = key.slice(paths.cliAuthorizationsPrefix.length, -'.json'.length);
	if (!CliAuthorizationId.is(encodedId)) return null;
	try {
		return decodeTime(encodedId);
	} catch {
		return null;
	}
}

export class CliAuthorizationService {
	static readonly AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
	static readonly PRUNE_LIMIT = 100;

	constructor(
		private bucket: Bucket,
		private tokens: TokenService,
	) {}

	async approve(
		input: ApproveCliAuthorizationInput,
		userId: UserId,
	): Promise<ApprovedCliAuthorization> {
		await this.pruneExpired();
		const id = createCliAuthorizationId();
		const secret = generateSecret();
		const now = new Date();
		const expiresAt = new Date(now.getTime() + CliAuthorizationService.AUTHORIZATION_TTL_MS);
		const record: CliAuthorization = {
			id,
			user_id: userId,
			code_hash: await hash(secret),
			code_challenge: input.codeChallenge,
			token_name: input.tokenName,
			expires_in_days: input.expiresInDays,
			created_at: now.toISOString(),
			expires_at: expiresAt.toISOString(),
			status: 'pending',
		};
		await this.bucket.put(paths.cliAuthorization(id), JSON.stringify(record), {
			onlyIfNotExists: true,
		});
		return {
			code: `${AUTHORIZATION_PREFIX}${id}_${secret}`,
			expiresAt: expiresAt.toISOString(),
		};
	}

	async exchange(code: string, codeVerifier: string): Promise<CreatedToken> {
		const match = AUTHORIZATION_RE.exec(code);
		if (!match) throw invalidAuthorization();
		const id = CliAuthorizationId.parse(match[1]);
		const key = paths.cliAuthorization(id);
		const object = await this.bucket.get(key);
		if (!object) throw invalidAuthorization();
		const record = await readAuthorization(object, key);
		if (record?.status !== 'pending' || new Date(record.expires_at).getTime() <= Date.now()) {
			throw invalidAuthorization();
		}

		const encoder = new TextEncoder();
		const presentedHash = encoder.encode(await hash(match[2]));
		if (!timingSafeEqual(presentedHash, encoder.encode(record.code_hash))) {
			throw invalidAuthorization();
		}
		const challenge = toBase64Url(await sha256(codeVerifier));
		if (!timingSafeEqual(encoder.encode(challenge), encoder.encode(record.code_challenge))) {
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
				{ name: record.token_name, expiresInDays: record.expires_in_days },
				record.user_id,
			);
		} finally {
			try {
				await this.bucket.delete(key);
			} catch (error) {
				logOperationalError(
					'cli_authorization_cleanup_failed',
					{ operation: 'cli_authorization.exchange', object: key },
					error,
				);
			}
		}
	}

	private async pruneExpired(): Promise<void> {
		const now = Date.now();
		const page = await this.bucket.list({
			prefix: paths.cliAuthorizationsPrefix,
			limit: CliAuthorizationService.PRUNE_LIMIT,
		});
		const expired = page.objects
			.filter((entry) => {
				const createdAt = authorizationCreatedAt(entry.key);
				return (
					createdAt === null || createdAt + CliAuthorizationService.AUTHORIZATION_TTL_MS <= now
				);
			})
			.map((entry) => entry.key);
		if (expired.length > 0) await this.bucket.delete(expired);
	}
}
