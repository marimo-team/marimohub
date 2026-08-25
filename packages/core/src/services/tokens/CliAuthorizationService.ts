import { z } from 'zod';
import { decodeTime } from 'ulidx';
import type { Bucket, BucketObject, BucketObjectBody } from '../../ports/bucket';
import { BadRequestError, PreconditionFailedError, ResourceExhaustedError } from '../../errors';
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
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;
const USER_CODE_CREATE_ATTEMPTS = 5;

export function parseCliAuthorizationCode(
	code: string,
): { id: CliAuthorizationId; secret: string } | null {
	const match = AUTHORIZATION_RE.exec(code);
	return match ? { id: CliAuthorizationId.parse(match[1]), secret: match[2] } : null;
}

const AuthorizationCommonSchema = {
	id: z.string().refine(CliAuthorizationId.is),
	code_hash: z.string().regex(/^[0-9a-f]{64}$/),
	code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	created_at: z.iso.datetime(),
	expires_at: z.iso.datetime(),
};

const ApprovedAuthorizationSchema = {
	...AuthorizationCommonSchema,
	flow: z.enum(['loopback', 'device']).default('loopback'),
	user_id: UserIdSchema,
	user_code: z.string().regex(USER_CODE_RE).optional(),
	token_name: z.string().min(1).max(100),
	expires_in_days: z.number().int().min(1).max(3650),
};

const CliAuthorizationSchema = z.discriminatedUnion('status', [
	z.looseObject({
		...AuthorizationCommonSchema,
		flow: z.literal('device'),
		status: z.literal('device_pending'),
		user_code: z.string().regex(USER_CODE_RE),
	}),
	z.looseObject({ ...ApprovedAuthorizationSchema, status: z.literal('pending') }),
	z.looseObject({ ...ApprovedAuthorizationSchema, status: z.literal('claimed') }),
]);

const DeviceUserCodeClaimSchema = z.object({
	authorization_id: z.string().refine(CliAuthorizationId.is),
});

type CliAuthorization = z.infer<typeof CliAuthorizationSchema>;
type PendingCliAuthorization = Extract<CliAuthorization, { status: 'pending' }>;

export interface ApproveCliAuthorizationInput {
	codeChallenge: string;
	tokenName: string;
	expiresInDays: number;
}

export interface ApprovedCliAuthorization {
	code: string;
	expiresAt: string;
}

export interface RequestedCliDeviceAuthorization extends ApprovedCliAuthorization {
	userCode: string;
}

export type CliDevicePollResult =
	| { status: 'pending' }
	| { status: 'approved'; credential: CreatedToken };

function generateSecret(): string {
	const bytes = new Uint8Array(SECRET_LENGTH);
	crypto.getRandomValues(bytes);
	let secret = '';
	for (let index = 0; index < SECRET_LENGTH; index += 1) {
		secret += SECRET_ALPHABET[bytes[index] & 31];
	}
	return secret;
}

function generateUserCode(): string {
	let code = '';
	while (code.length < USER_CODE_LENGTH) {
		const bytes = new Uint8Array(USER_CODE_LENGTH);
		crypto.getRandomValues(bytes);
		for (const byte of bytes) {
			if (byte >= 240) continue;
			code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
			if (code.length === USER_CODE_LENGTH) break;
		}
	}
	return code;
}

export function normalizeCliDeviceUserCode(value: string): string | null {
	const normalized = value.toUpperCase().replaceAll(/[\s-]/g, '');
	return USER_CODE_RE.test(normalized) ? normalized : null;
}

export function formatCliDeviceUserCode(value: string): string {
	return `${value.slice(0, 4)}-${value.slice(4)}`;
}

async function sha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function hash(value: string): Promise<string> {
	return toHex(await sha256(value));
}

async function createAuthorization(codeChallenge: string) {
	const id = createCliAuthorizationId();
	const secret = generateSecret();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + CliAuthorizationService.AUTHORIZATION_TTL_MS);
	return {
		id,
		secret,
		expiresAt,
		common: {
			id,
			code_hash: await hash(secret),
			code_challenge: codeChallenge,
			created_at: now.toISOString(),
			expires_at: expiresAt.toISOString(),
		},
	};
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
		const { id, secret, expiresAt, common } = await createAuthorization(input.codeChallenge);
		const record: PendingCliAuthorization = {
			...common,
			flow: 'loopback',
			user_id: userId,
			token_name: input.tokenName,
			expires_in_days: input.expiresInDays,
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

	async requestDevice(codeChallenge: string): Promise<RequestedCliDeviceAuthorization> {
		await Promise.all([this.pruneExpired(), this.pruneExpiredUserCodes()]);
		for (let attempt = 0; attempt < USER_CODE_CREATE_ATTEMPTS; attempt += 1) {
			const { id, secret, expiresAt, common } = await createAuthorization(codeChallenge);
			const userCode = generateUserCode();
			const claimKey = paths.cliDeviceUserCode(userCode);
			try {
				await this.bucket.put(claimKey, JSON.stringify({ authorization_id: id }), {
					onlyIfNotExists: true,
				});
			} catch (error) {
				if (error instanceof PreconditionFailedError) continue;
				throw error;
			}

			const record: CliAuthorization = {
				...common,
				flow: 'device',
				user_code: userCode,
				status: 'device_pending',
			};
			try {
				await this.bucket.put(paths.cliAuthorization(id), JSON.stringify(record), {
					onlyIfNotExists: true,
				});
			} catch (error) {
				await this.cleanup(claimKey, 'cli_authorization.request_device');
				throw error;
			}
			return {
				code: `${AUTHORIZATION_PREFIX}${id}_${secret}`,
				userCode: formatCliDeviceUserCode(userCode),
				expiresAt: expiresAt.toISOString(),
			};
		}
		throw new ResourceExhaustedError('Could not allocate a unique CLI device code');
	}

	async approveDevice(
		userCode: string,
		input: Omit<ApproveCliAuthorizationInput, 'codeChallenge'>,
		userId: UserId,
	): Promise<{ expiresAt: string }> {
		const normalized = normalizeCliDeviceUserCode(userCode);
		if (!normalized) throw invalidAuthorization();
		const claimKey = paths.cliDeviceUserCode(normalized);
		const claimObject = await this.bucket.get(claimKey);
		if (!claimObject) throw invalidAuthorization();
		let claim: z.infer<typeof DeviceUserCodeClaimSchema>;
		try {
			claim = await readStored(DeviceUserCodeClaimSchema, claimObject, claimKey);
		} catch {
			throw invalidAuthorization();
		}
		const id = CliAuthorizationId.parse(claim.authorization_id);
		const key = paths.cliAuthorization(id);
		const object = await this.bucket.get(key);
		if (!object) throw invalidAuthorization();
		const record = await readAuthorization(object, key);
		if (
			record?.status !== 'device_pending' ||
			record.user_code !== normalized ||
			new Date(record.expires_at).getTime() <= Date.now()
		) {
			throw invalidAuthorization();
		}
		try {
			await this.bucket.put(
				key,
				JSON.stringify({
					...record,
					status: 'pending',
					user_id: userId,
					token_name: input.tokenName,
					expires_in_days: input.expiresInDays,
				}),
				{ onlyIfEtagMatches: object.etag },
			);
		} catch (error) {
			if (error instanceof PreconditionFailedError) throw invalidAuthorization();
			throw error;
		}
		return { expiresAt: record.expires_at };
	}

	async exchange(code: string, codeVerifier: string): Promise<CreatedToken> {
		const presented = await this.readPresented(code, codeVerifier);
		if (presented.record.flow !== 'loopback' || presented.record.status !== 'pending') {
			throw invalidAuthorization();
		}
		return this.claimPresented(presented.key, presented.object, presented.record);
	}

	async pollDevice(code: string, codeVerifier: string): Promise<CliDevicePollResult> {
		const presented = await this.readPresented(code, codeVerifier);
		if (presented.record.flow !== 'device') throw invalidAuthorization();
		if (presented.record.status === 'device_pending') return { status: 'pending' };
		if (presented.record.status !== 'pending') throw invalidAuthorization();
		return {
			status: 'approved',
			credential: await this.claimPresented(presented.key, presented.object, presented.record),
		};
	}

	private async readPresented(code: string, codeVerifier: string) {
		const parsed = parseCliAuthorizationCode(code);
		if (!parsed) throw invalidAuthorization();
		const { id, secret } = parsed;
		const key = paths.cliAuthorization(id);
		const object = await this.bucket.get(key);
		if (!object) throw invalidAuthorization();
		const record = await readAuthorization(object, key);
		if (
			!record ||
			record.status === 'claimed' ||
			new Date(record.expires_at).getTime() <= Date.now()
		) {
			throw invalidAuthorization();
		}

		const encoder = new TextEncoder();
		const presentedHash = encoder.encode(await hash(secret));
		if (!timingSafeEqual(presentedHash, encoder.encode(record.code_hash))) {
			throw invalidAuthorization();
		}
		const challenge = toBase64Url(await sha256(codeVerifier));
		if (!timingSafeEqual(encoder.encode(challenge), encoder.encode(record.code_challenge))) {
			throw invalidAuthorization();
		}
		return { key, object, record };
	}

	private async claimPresented(
		key: string,
		object: BucketObjectBody,
		record: PendingCliAuthorization,
	): Promise<CreatedToken> {
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
			await this.cleanup(
				[key, ...(record.user_code ? [paths.cliDeviceUserCode(record.user_code)] : [])],
				'cli_authorization.exchange',
			);
		}
	}

	private async cleanup(keys: string | string[], operation: string): Promise<void> {
		try {
			await this.bucket.delete(keys);
		} catch (error) {
			logOperationalError(
				'cli_authorization_cleanup_failed',
				{ operation, object: Array.isArray(keys) ? keys[0] : keys },
				error,
			);
		}
	}

	private async prune(
		prefix: string,
		isExpired: (entry: BucketObject, now: number) => boolean,
	): Promise<void> {
		const page = await this.bucket.list({ prefix, limit: CliAuthorizationService.PRUNE_LIMIT });
		const now = Date.now();
		const expired = page.objects.filter((entry) => isExpired(entry, now)).map((entry) => entry.key);
		if (expired.length > 0) await this.bucket.delete(expired);
	}

	private async pruneExpired(): Promise<void> {
		await this.prune(paths.cliAuthorizationsPrefix, (entry, now) => {
			const createdAt = authorizationCreatedAt(entry.key);
			return createdAt === null || createdAt + CliAuthorizationService.AUTHORIZATION_TTL_MS <= now;
		});
	}

	private async pruneExpiredUserCodes(): Promise<void> {
		await this.prune(
			paths.cliDeviceUserCodesPrefix,
			(entry, now) =>
				entry.uploaded.getTime() + CliAuthorizationService.AUTHORIZATION_TTL_MS <= now,
		);
	}
}
