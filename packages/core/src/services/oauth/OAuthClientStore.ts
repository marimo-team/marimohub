import { z } from 'zod';
import type { Bucket, BucketObjectBody } from '../../ports/bucket';
import { BadRequestError } from '../../errors';
import { createOAuthClientId, OAuthClientId } from '../../ids';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import { readStored } from '../../schema';
import { authorizationCreatedAt } from '../tokens/authorizationCodes';

const OAuthClientRecordSchema = z.looseObject({
	client_id: z.string().refine(OAuthClientId.is),
	client_id_issued_at: z.number().int().nonnegative(),
	expires_at: z.iso.datetime(),
	redirect_uris: z.array(z.string()).min(1),
	token_endpoint_auth_method: z.literal('none'),
	client_name: z.string().min(1).max(200).optional(),
	client_uri: z.string().optional(),
	scope: z.string().optional(),
	grant_types: z.array(z.string()).optional(),
	response_types: z.array(z.string()).optional(),
});

export type OAuthClientRecord = z.infer<typeof OAuthClientRecordSchema>;

export interface RegisterOAuthClientInput {
	client_name?: string;
	client_uri?: string;
	redirect_uris: string[];
	scope?: string;
	grant_types?: string[];
	response_types?: string[];
}

// Cursor predates the reverse-domain convention recommended by RFC 8252 section 7.1.
const SUPPORTED_PRIVATE_USE_REDIRECT_SCHEMES = new Set(['cursor:']);
const REVERSE_DOMAIN_PRIVATE_USE_SCHEME =
	/^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+:$/;

function validRedirectUri(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.hash) return false;
	if (url.protocol === 'https:') return true;
	if (url.protocol === 'http:') {
		return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
	}
	if (SUPPORTED_PRIVATE_USE_REDIRECT_SCHEMES.has(url.protocol)) {
		return url.host.length > 0 || url.pathname.startsWith('/');
	}
	return (
		REVERSE_DOMAIN_PRIVATE_USE_SCHEME.test(url.protocol) &&
		url.host.length === 0 &&
		url.pathname.startsWith('/')
	);
}

async function readClient(
	object: BucketObjectBody,
	key: string,
): Promise<OAuthClientRecord | null> {
	try {
		return await readStored(OAuthClientRecordSchema, object, key);
	} catch (error) {
		logOperationalError(
			'stored_object_skipped',
			{ operation: 'oauth_client.read', object: key },
			error,
		);
		return null;
	}
}

export class OAuthClientStore {
	static readonly CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
	static readonly PRUNE_LIMIT = 100;

	constructor(private bucket: Bucket) {}

	async register(input: RegisterOAuthClientInput): Promise<OAuthClientRecord> {
		if (
			input.redirect_uris.length === 0 ||
			input.redirect_uris.some((uri) => !validRedirectUri(uri))
		) {
			throw new BadRequestError(
				'OAuth redirect_uris must use HTTPS, a loopback HTTP URL, or a supported private-use scheme',
			);
		}
		await this.pruneExpired();
		const id = createOAuthClientId();
		const now = Date.now();
		const record: OAuthClientRecord = {
			client_id: id,
			client_id_issued_at: Math.floor(now / 1000),
			expires_at: new Date(now + OAuthClientStore.CLIENT_TTL_MS).toISOString(),
			redirect_uris: input.redirect_uris,
			token_endpoint_auth_method: 'none',
			...(input.client_name ? { client_name: input.client_name } : {}),
			...(input.client_uri ? { client_uri: input.client_uri } : {}),
			...(input.scope ? { scope: input.scope } : {}),
			...(input.grant_types ? { grant_types: input.grant_types } : {}),
			...(input.response_types ? { response_types: input.response_types } : {}),
		};
		const validated = OAuthClientRecordSchema.safeParse(record);
		if (!validated.success) throw new BadRequestError('OAuth client metadata is invalid');
		await this.bucket.put(paths.oauthClient(id), JSON.stringify(validated.data), {
			onlyIfNotExists: true,
		});
		return validated.data;
	}

	async get(clientId: string): Promise<OAuthClientRecord | null> {
		if (!OAuthClientId.is(clientId)) return null;
		const key = paths.oauthClient(clientId);
		const object = await this.bucket.get(key);
		if (!object) return null;
		const record = await readClient(object, key);
		if (!record || new Date(record.expires_at).getTime() <= Date.now()) return null;
		return record;
	}

	async pruneExpired(): Promise<void> {
		const page = await this.bucket.list({
			prefix: paths.oauthClientsPrefix,
			limit: OAuthClientStore.PRUNE_LIMIT,
		});
		const now = Date.now();
		const expired = page.objects
			.filter((entry) => {
				const createdAt = authorizationCreatedAt(
					entry.key,
					paths.oauthClientsPrefix,
					OAuthClientId.is,
				);
				return createdAt === null || createdAt + OAuthClientStore.CLIENT_TTL_MS <= now;
			})
			.map((entry) => entry.key);
		if (expired.length > 0) await this.bucket.delete(expired);
	}
}
