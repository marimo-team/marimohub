import { HTTPException } from 'hono/http-exception';
import {
	createSessionId,
	exchangeFederatedStorageCredentials,
	ForbiddenError,
	LazyMap,
	NotFoundError,
	ObjectBrowseError,
	PreconditionFailedError,
	UnavailableError,
	ValidationError,
} from '@marimo-hub/core';
import type { AuthUser, ObjectBrowseContext, Project, TempS3Creds } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { federationFor } from '../federation';

const CACHE_REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_CREDENTIAL_CACHE_ENTRIES = 256;

interface CachedCredentials {
	credentials: TempS3Creds;
	expiresAt: number;
}

type CredentialCache = LazyMap<string, CachedCredentials>;

function createCredentialCache(): CredentialCache {
	return new LazyMap(
		async () => {
			throw new Error('A credential load function is required.');
		},
		{ maxSize: MAX_CREDENTIAL_CACHE_ENTRIES },
	);
}

let credentialCaches = new WeakMap<ApiDeps, CredentialCache>();

function credentialCache(deps: ApiDeps): CredentialCache {
	let cache = credentialCaches.get(deps);
	if (!cache) {
		cache = createCredentialCache();
		credentialCaches.set(deps, cache);
	}
	return cache;
}

export async function makeObjectBrowseContext(
	deps: ApiDeps,
	project: Project,
	user: AuthUser,
	signal?: AbortSignal,
	options: {
		integrationId?: string;
		includeFederated?: boolean;
		allowServerAmbient?: boolean;
		disableS3Ambient?: boolean;
	} = {},
): Promise<ObjectBrowseContext> {
	const browser = deps.dataBrowser?.objectBrowser;
	const wif = options.includeFederated !== false ? federationFor(project, deps.wif) : undefined;
	const context: ObjectBrowseContext = {
		project_id: project.id,
		user_id: user.id,
		user_email: user.email,
		allow_server_ambient: {
			s3:
				wif || options.disableS3Ambient
					? false
					: (options.allowServerAmbient ?? browser?.allowServerAmbientCredentials ?? false),
			gcs: options.allowServerAmbient ?? browser?.allowServerAmbientCredentials ?? false,
			azure_blob: options.allowServerAmbient ?? browser?.allowServerAmbientCredentials ?? false,
		},
		...(signal ? { signal } : {}),
	};
	if (!wif) {
		return context;
	}

	const temporary = await cachedFederatedCredentials(
		deps,
		project.id,
		user.id,
		options.integrationId,
	);
	return temporary
		? {
				...context,
				federation: {
					provider: 's3',
					credentials: temporary,
					storage: wif.target.storage,
				},
			}
		: context;
}

async function cachedFederatedCredentials(
	deps: ApiDeps,
	projectId: Project['id'],
	userId: AuthUser['id'],
	integrationId?: string,
): Promise<TempS3Creds | undefined> {
	const wif = deps.wif;
	if (!wif) return undefined;
	const key = JSON.stringify([
		projectId,
		userId,
		integrationId ?? null,
		wif.target.audience,
		wif.target.storage.endpoint ?? null,
		wif.target.storage.region ?? null,
	]);
	const credentials = credentialCache(deps);
	const now = Date.now();
	const cached = credentials.getIfPresent(key);
	if (cached && cached.expiresAt - CACHE_REFRESH_SKEW_MS > now) return cached.credentials;
	if (cached) credentials.delete(key);

	try {
		const loaded = await credentials.getOrLoad(key, async () => {
			const value = await exchangeFederatedStorageCredentials(
				wif.issuer,
				wif.issuerUrl,
				wif.target,
				projectId,
				{ kind: 'session', id: createSessionId() },
			);
			const expiresAt = value.expiration ? Date.parse(value.expiration) : Number.NaN;
			return { credentials: value, expiresAt };
		});
		if (loaded.expiresAt - CACHE_REFRESH_SKEW_MS <= Date.now()) credentials.delete(key);
		return loaded.credentials;
	} catch {
		return undefined;
	}
}

export function clearObjectCredentialCacheForTests(): void {
	credentialCaches = new WeakMap();
}

export async function runObjectBrowse<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!(error instanceof ObjectBrowseError)) throw error;
		switch (error.code) {
			case 'access_denied':
				throw new ForbiddenError(error.message);
			case 'not_found':
				throw new NotFoundError(error.message);
			case 'precondition_failed':
				throw new PreconditionFailedError(error.message);
			case 'range_not_satisfiable':
				throw new HTTPException(416, { message: error.message });
			case 'invalid_cursor':
			case 'unsupported':
				throw new ValidationError(error.message);
			case 'aborted':
			case 'unavailable':
				throw new UnavailableError(error.message);
		}
	}
}
