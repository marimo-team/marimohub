import { z } from 'zod';
import type { Bucket, BucketObject } from '../../ports/bucket';
import type { ManagedSecretCodec, SecretEnvelope } from '../../ports/secrets';
import { UserId } from '../../ids';
import type {
	SourceControlAccountProvider,
	SourceControlAccountReference,
} from '../../ports/sourceControlAccount';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	ResourceExhaustedError,
	UnavailableError,
} from '../../errors';
import { readStored, SecretEnvelopeSchema } from '../../schema';
import { withCasRetry } from '../catalog/cas';
import { toBase64Url } from '../../internal/base64url';
import { logEvent } from '../../logs';

const RATE_LIMIT_WINDOW_MS = 15 * 60_000;
const CONNECT_LIMIT = 10;
const CALLBACK_LIMIT = 30;

const tokensSchema = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1),
	expiresAt: z.number(),
	refreshExpiresAt: z.number(),
});
const headSchema = z.object({
	version: z.literal(1),
	generation: z.string(),
	connection: z.string().optional(),
	attempt: z
		.object({
			state: z.string(),
			browser: z.string(),
			verifier: SecretEnvelopeSchema,
			expires: z.number(),
			binding: z.string(),
		})
		.optional(),
	attempts: z.array(z.number()).max(CONNECT_LIMIT),
	callbacks: z.array(z.number()).max(CALLBACK_LIMIT).default([]),
});
const accountSchema = z.object({
	version: z.literal(1),
	createdAt: z.number(),
	headGeneration: z.string(),
	id: z.string(),
	generation: z.string(),
	provider: z.string(),
	origin: z.string(),
	clientId: z.string(),
	accountId: z.string(),
	login: z.string(),
	tokens: SecretEnvelopeSchema.optional(),
	refreshClaim: z.string().optional(),
	refreshUntil: z.number().optional(),
});
type Head = z.infer<typeof headSchema>;
type Account = z.infer<typeof accountSchema>;
const random = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const digest = async (value: string) =>
	toBase64Url(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
	);

export class SourceControlAccountService {
	constructor(
		private readonly bucket: Bucket,
		private readonly codec: ManagedSecretCodec,
		readonly provider: SourceControlAccountProvider,
		readonly redirectUri: string,
		private readonly now: () => number = Date.now,
	) {}

	private prefix(uid: UserId) {
		return `_system/source-control-accounts/${uid}/`;
	}
	private headKey(uid: UserId) {
		return `${this.prefix(uid)}head.json`;
	}
	private key(uid: UserId, id: string) {
		return `${this.prefix(uid)}${id}.json`;
	}
	private matchesApp(account: Account): boolean {
		return account.origin === this.provider.origin && account.clientId === this.provider.clientId;
	}
	private oauthBinding(): string {
		return `${this.provider.provider}|${this.provider.origin}|${this.provider.clientId}|${this.redirectUri}`;
	}
	private recentAttempts(attempts: number[]): number[] {
		return attempts.filter((at) => this.now() - at < RATE_LIMIT_WINDOW_MS);
	}
	private async decryptTokens(envelope: SecretEnvelope, path: string) {
		return tokensSchema.parse(JSON.parse(await this.codec.decrypt(envelope, { path })));
	}
	private async revocationToken(account: Account, key: string): Promise<string | undefined> {
		if (!account.tokens || !this.matchesApp(account)) return;
		try {
			return (await this.decryptTokens(account.tokens, key)).accessToken;
		} catch {
			// Local removal must survive unavailable decryption keys.
			return;
		}
	}
	private async readHead(uid: UserId) {
		const key = this.headKey(uid);
		const object = await this.bucket.get(key);
		return {
			object,
			head: object
				? await readStored(headSchema, object, key)
				: { version: 1 as const, generation: random(), attempts: [], callbacks: [] },
		};
	}
	private async mutateHead<T>(uid: UserId, update: (head: Head) => T) {
		return withCasRetry(this.bucket, async (writer) => {
			const { object, head } = await this.readHead(uid);
			const result = update(head);
			await writer.put(
				this.headKey(uid),
				JSON.stringify(head),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
			return result;
		});
	}
	private async readAccount(uid: UserId, id: string, requireProvider = true) {
		if (!/^[A-Za-z0-9_-]{43}$/.test(id))
			throw new ForbiddenError('GitHub account connection is invalid');
		const key = this.key(uid, id);
		const object = await this.bucket.get(key);
		if (!object) throw new ForbiddenError('Connect your GitHub account');
		const account = await readStored(accountSchema, object, key);
		if (
			requireProvider &&
			(account.provider !== this.provider.provider || !this.matchesApp(account))
		)
			throw new ForbiddenError('Reconnect your GitHub account to the configured App');
		return { object, account, key };
	}

	async status(uid: UserId) {
		const { head } = await this.readHead(uid);
		if (!head.connection) return null;
		const { account } = await this.readAccount(uid, head.connection, false);
		return {
			login: account.login,
			account_id: account.accountId,
			connected:
				!!account.tokens &&
				!account.refreshClaim &&
				account.generation === head.generation &&
				this.matchesApp(account),
		};
	}

	async begin(uid: UserId, browser: string): Promise<string> {
		const state = random();
		const verifier = random();
		const expires = this.now() + 10 * 60_000;
		const attempt = {
			state: await digest(state),
			browser: await digest(browser),
			verifier: await this.codec.encrypt(verifier, { path: this.headKey(uid) }),
			expires,
			binding: this.oauthBinding(),
		};
		await this.mutateHead(uid, (head) => {
			head.attempts = this.recentAttempts(head.attempts);
			if (head.attempts.length >= CONNECT_LIMIT)
				throw new ResourceExhaustedError('Too many GitHub connection attempts');
			head.attempts.push(this.now());
			head.attempt = attempt;
		});
		return this.provider.authorizationUrl({
			state,
			challenge: await digest(verifier),
			redirectUri: this.redirectUri,
		});
	}

	async complete(uid: UserId, browser: string, state: string, code: string): Promise<void> {
		if (state.length > 128 || code.length > 1024 || browser.length > 128)
			throw new BadRequestError('Invalid GitHub authorization response');
		const stateHash = await digest(state),
			browserHash = await digest(browser);
		const consumed = await this.mutateHead(uid, (head) => {
			head.callbacks = this.recentAttempts(head.callbacks);
			if (head.callbacks.length >= CALLBACK_LIMIT)
				throw new ResourceExhaustedError('Too many GitHub callback attempts');
			head.callbacks.push(this.now());
			const attempt = head.attempt;
			if (
				!attempt ||
				attempt.expires <= this.now() ||
				attempt.state !== stateHash ||
				attempt.browser !== browserHash ||
				attempt.binding !== this.oauthBinding()
			)
				return;
			delete head.attempt;
			return { attempt, generation: head.generation };
		});
		if (!consumed)
			throw new ForbiddenError('GitHub authorization expired or does not match this browser');
		const verifier = await this.codec.decrypt(consumed.attempt.verifier, {
			path: this.headKey(uid),
		});
		const tokens = tokensSchema.parse(
			await this.provider.exchange({ code, verifier, redirectUri: this.redirectUri }),
		);
		const id = random(),
			generation = random(),
			key = this.key(uid, id);
		let record: Account;
		try {
			const identity = await this.provider.identity(tokens.accessToken);
			record = {
				version: 1,
				createdAt: this.now(),
				headGeneration: consumed.generation,
				id,
				generation,
				provider: this.provider.provider,
				origin: this.provider.origin,
				clientId: this.provider.clientId,
				accountId: identity.id,
				login: identity.login,
				tokens: await this.codec.encrypt(JSON.stringify(tokens), { path: key }),
			};
			await this.bucket.put(key, JSON.stringify(record), { onlyIfNotExists: true });
		} catch (error) {
			await this.revokeToken(tokens.accessToken);
			throw error;
		}
		try {
			await this.mutateHead(uid, (head) => {
				if (
					head.generation !== consumed.generation ||
					head.connection ||
					this.now() > record.createdAt + 10 * 60_000
				)
					throw new ConflictError(
						'Disconnect the existing GitHub account before connecting another',
					);
				head.generation = generation;
				head.connection = id;
			});
		} catch (error) {
			// A lost response may hide a successful head CAS; never revoke its credential.
			const latest = await this.readHead(uid);
			if (latest.head.connection !== id || latest.head.generation !== generation) throw error;
		}
		logEvent({
			level: 'info',
			event: 'source_control.account_connected',
			user_id: uid,
			connection_id: id,
		});
	}

	private async revokeToken(accessToken: string): Promise<boolean> {
		try {
			await this.provider.revoke(accessToken);
			return true;
		} catch {
			return false;
		}
	}

	async reference(uid: UserId): Promise<SourceControlAccountReference> {
		const { head } = await this.readHead(uid);
		if (!head.connection) throw new ForbiddenError('Connect your GitHub account before publishing');
		const { account } = await this.readAccount(uid, head.connection);
		if (!account.tokens || account.generation !== head.generation)
			throw new ForbiddenError('Reconnect your GitHub account');
		return { connectionId: account.id, generation: head.generation, accountId: account.accountId };
	}

	async assertCurrent(uid: UserId, reference: SourceControlAccountReference): Promise<void> {
		const current = await this.reference(uid);
		if (
			current.connectionId !== reference.connectionId ||
			current.generation !== reference.generation ||
			current.accountId !== reference.accountId
		)
			throw new ForbiddenError('The GitHub account used by this operation is no longer connected');
	}

	async accessToken(uid: UserId, reference: SourceControlAccountReference): Promise<string> {
		await this.assertCurrent(uid, reference);
		const {
			account: storedAccount,
			key,
			object,
		} = await this.readAccount(uid, reference.connectionId);
		let account = storedAccount;
		if (!account.tokens) throw new ForbiddenError('Reconnect your GitHub account');
		let tokens = await this.decryptTokens(account.tokens, key);
		if (tokens.expiresAt <= this.now() + 60_000) {
			if (account.refreshClaim)
				throw new ConflictError(
					account.refreshUntil! > this.now()
						? 'GitHub credentials are refreshing; retry shortly'
						: 'GitHub credential refresh was interrupted; reconnect your account',
				);
			if (tokens.refreshExpiresAt <= this.now())
				throw new ForbiddenError('Reconnect your GitHub account');
			account = { ...account, refreshClaim: random(), refreshUntil: this.now() + 60_000 };
			const claimed: BucketObject = await this.bucket.put(key, JSON.stringify(account), {
				onlyIfEtagMatches: object.etag,
			});
			let issued: string | undefined;
			let persistenceStarted = false;
			try {
				tokens = tokensSchema.parse(await this.provider.refresh(tokens.refreshToken));
				issued = tokens.accessToken;
				await this.assertCurrent(uid, reference);
				account.tokens = await this.codec.encrypt(JSON.stringify(tokens), { path: key });
				delete account.refreshClaim;
				delete account.refreshUntil;
				persistenceStarted = true;
				await this.bucket.put(key, JSON.stringify(account), { onlyIfEtagMatches: claimed.etag });
			} catch {
				let retained = false,
					disconnected = false;
				try {
					const current = await this.readHead(uid);
					disconnected =
						current.head.connection !== reference.connectionId ||
						current.head.generation !== reference.generation;
					if (issued && persistenceStarted && !disconnected) {
						const stored = await this.readAccount(uid, reference.connectionId);
						retained =
							!!stored.account.tokens &&
							!stored.account.refreshClaim &&
							(await this.decryptTokens(stored.account.tokens, key)).accessToken === issued;
					}
				} catch {
					/* An uncertain persisted token must not be revoked blindly. */
				}
				if (!retained) {
					if (issued && (!persistenceStarted || disconnected)) await this.revokeToken(issued);
					logEvent({
						level: 'warn',
						event: 'source_control.account_refresh_failed',
						user_id: uid,
						connection_id: reference.connectionId,
					});
					throw new UnavailableError(
						'GitHub credential refresh could not be confirmed; reconnect your account',
					);
				}
			}
		}
		const identity = await this.provider.identity(tokens.accessToken);
		if (identity.id !== reference.accountId)
			throw new ForbiddenError('GitHub account identity changed; reconnect');
		await this.assertCurrent(uid, reference);
		return tokens.accessToken;
	}

	async disconnect(uid: UserId): Promise<{ remote_revocation_confirmed: boolean }> {
		const id = await this.mutateHead(uid, (head) => {
			const id = head.connection;
			delete head.connection;
			delete head.attempt;
			head.generation = random();
			return id;
		});
		if (!id) return { remote_revocation_confirmed: true };
		let accessToken: string | undefined;
		let uncertain = false;
		await withCasRetry(this.bucket, async (writer) => {
			const { object, account, key } = await this.readAccount(uid, id, false);
			accessToken = await this.revocationToken(account, key);
			uncertain = !!account.refreshClaim || (!!account.tokens && !accessToken);
			delete account.tokens;
			delete account.refreshClaim;
			delete account.refreshUntil;
			await writer.put(key, JSON.stringify(account), { onlyIfEtagMatches: object.etag });
		});
		const revoked = accessToken ? await this.revokeToken(accessToken) : true;
		logEvent({
			level: 'info',
			event: 'source_control.account_disconnected',
			user_id: uid,
			connection_id: id,
		});
		return { remote_revocation_confirmed: revoked && !uncertain };
	}
	async sweep(): Promise<void> {
		const cursorKey = '_system/source-control-account-cleanup.json';
		const cursor = await this.bucket.get(cursorKey);
		let stored: { after?: string } = {};
		if (cursor) {
			try {
				stored = z.object({ after: z.string().optional() }).parse(await cursor.json());
			} catch {
				/* Corrupt cleanup cursors restart their bounded scan. */
			}
		}
		const page = await this.bucket.list({
			prefix: '_system/source-control-accounts/',
			startAfter: stored.after,
			limit: 100,
		});
		for (const item of page.objects) {
			const parts = item.key.split('/');
			const uid = UserId.parse(parts[2]);
			if (parts[3] === 'head.json') {
				await this.mutateHead(uid, (head) => {
					if (head.attempt && head.attempt.expires <= this.now()) delete head.attempt;
					head.attempts = this.recentAttempts(head.attempts);
					head.callbacks = this.recentAttempts(head.callbacks);
				});
				continue;
			}
			const { account, key, object } = await this.readAccount(
				uid,
				parts[3].replace(/\.json$/, ''),
				false,
			);
			if (!account.tokens || this.now() - account.createdAt < 15 * 60_000) continue;
			const orphan = await this.mutateHead(uid, (head) => {
				if (head.connection === account.id) return false;
				if (!head.connection && head.generation === account.headGeneration)
					head.generation = random();
				return true;
			});
			if (!orphan) continue;
			const accessToken = await this.revocationToken(account, key);
			delete account.tokens;
			delete account.refreshClaim;
			delete account.refreshUntil;
			await this.bucket.put(key, JSON.stringify(account), { onlyIfEtagMatches: object.etag });
			if (accessToken) await this.revokeToken(accessToken);
		}
		await this.bucket.put(
			cursorKey,
			JSON.stringify({ after: page.truncated ? page.objects.at(-1)?.key : undefined }),
			cursor ? { onlyIfEtagMatches: cursor.etag } : { onlyIfNotExists: true },
		);
	}
}
