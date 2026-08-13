import { readFile } from 'node:fs/promises';
import { importPKCS8, SignJWT } from 'jose';
import type { GcsObjectStoreSource, ObjectBrowseContext } from '@marimo-hub/core';
import { ObjectBrowseError } from '@marimo-hub/core';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only';
const METADATA_TOKEN =
	'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const METADATA_PROJECT = 'http://metadata.google.internal/computeMetadata/v1/project/project-id';

export interface GcsServiceAccount {
	client_email: string;
	private_key: string;
	project_id?: string;
	token_uri?: string;
}

export function parseServiceAccount(raw: string): GcsServiceAccount {
	try {
		const value: unknown = JSON.parse(raw);
		if (
			typeof value !== 'object' ||
			value === null ||
			typeof (value as GcsServiceAccount).client_email !== 'string' ||
			typeof (value as GcsServiceAccount).private_key !== 'string'
		) {
			throw new Error('shape');
		}
		return value as GcsServiceAccount;
	} catch {
		throw new ObjectBrowseError('unavailable', 'The GCS service-account credential is invalid.');
	}
}

export class GcsAuth {
	private cached?: { token: string; expires_at: number };
	private ambientAccount?: GcsServiceAccount;
	private ambientLoaded = false;

	constructor(
		private readonly source: GcsObjectStoreSource,
		private readonly context: ObjectBrowseContext,
		private readonly fetchImpl: typeof fetch,
	) {}

	async projectId(): Promise<string | undefined> {
		if (this.source.project_id) return this.source.project_id;
		const account = await this.account();
		if (account?.project_id) return account.project_id;
		if (this.source.auth.method !== 'ambient') return undefined;
		if (!this.context.allow_server_ambient.gcs) {
			throw new ObjectBrowseError(
				'access_denied',
				'Ambient GCS access is not enabled for this integration.',
			);
		}
		const environment = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
		if (environment) return environment;
		try {
			const response = await this.fetchImpl(METADATA_PROJECT, {
				headers: { 'Metadata-Flavor': 'Google' },
				signal: this.context.signal,
			});
			return response.ok ? (await response.text()).trim() || undefined : undefined;
		} catch {
			return undefined;
		}
	}

	async headers(): Promise<Record<string, string>> {
		const token = await this.token();
		return { Authorization: `Bearer ${token}` };
	}

	private async token(): Promise<string> {
		if (this.cached && this.cached.expires_at > Date.now() + 60_000) return this.cached.token;
		const account = await this.account();
		if (account) return this.serviceAccountToken(account);
		if (!this.context.allow_server_ambient.gcs) {
			throw new ObjectBrowseError(
				'access_denied',
				'Ambient GCS access is not enabled for this integration.',
			);
		}
		try {
			const response = await this.fetchImpl(METADATA_TOKEN, {
				headers: { 'Metadata-Flavor': 'Google' },
				signal: this.context.signal,
			});
			if (!response.ok) throw new Error('status');
			const value: unknown = await response.json();
			if (
				typeof value !== 'object' ||
				value === null ||
				typeof (value as { access_token?: unknown }).access_token !== 'string' ||
				typeof (value as { expires_in?: unknown }).expires_in !== 'number'
			) {
				throw new Error('shape');
			}
			const token = (value as { access_token: string }).access_token;
			const seconds = (value as { expires_in: number }).expires_in;
			this.cached = { token, expires_at: Date.now() + seconds * 1000 };
			return token;
		} catch (error) {
			if ((error as { name?: unknown })?.name === 'AbortError') {
				throw new ObjectBrowseError('aborted', 'The request was canceled.');
			}
			throw new ObjectBrowseError('access_denied', 'GCS application credentials are unavailable.');
		}
	}

	private async account(): Promise<GcsServiceAccount | undefined> {
		if (this.source.auth.method === 'service_account') {
			return parseServiceAccount(this.source.auth.credentials_json);
		}
		if (!this.context.allow_server_ambient.gcs) return undefined;
		if (this.ambientLoaded) return this.ambientAccount;
		this.ambientLoaded = true;
		const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
		if (!path) return undefined;
		try {
			this.ambientAccount = parseServiceAccount(await readFile(path, 'utf8'));
			return this.ambientAccount;
		} catch (error) {
			if (error instanceof ObjectBrowseError) throw error;
			throw new ObjectBrowseError('access_denied', 'GCS application credentials are unavailable.');
		}
	}

	private async serviceAccountToken(account: GcsServiceAccount): Promise<string> {
		const tokenUri = account.token_uri || TOKEN_URI;
		if (new URL(tokenUri).origin !== new URL(TOKEN_URI).origin) {
			throw new ObjectBrowseError('access_denied', 'The GCS token endpoint is not permitted.');
		}
		try {
			const key = await importPKCS8(account.private_key.replaceAll('\\n', '\n'), 'RS256');
			const assertion = await new SignJWT({ scope: STORAGE_SCOPE })
				.setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
				.setIssuer(account.client_email)
				.setSubject(account.client_email)
				.setAudience(tokenUri)
				.setIssuedAt()
				.setExpirationTime('1h')
				.sign(key);
			const response = await this.fetchImpl(tokenUri, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
					assertion,
				}),
				signal: this.context.signal,
			});
			if (!response.ok) throw new Error('status');
			const value: unknown = await response.json();
			if (
				typeof value !== 'object' ||
				value === null ||
				typeof (value as { access_token?: unknown }).access_token !== 'string' ||
				typeof (value as { expires_in?: unknown }).expires_in !== 'number'
			) {
				throw new Error('shape');
			}
			const token = (value as { access_token: string }).access_token;
			this.cached = {
				token,
				expires_at: Date.now() + (value as { expires_in: number }).expires_in * 1000,
			};
			return token;
		} catch (error) {
			if (error instanceof ObjectBrowseError) throw error;
			if ((error as { name?: unknown })?.name === 'AbortError') {
				throw new ObjectBrowseError('aborted', 'The request was canceled.');
			}
			throw new ObjectBrowseError('access_denied', 'GCS authentication failed.');
		}
	}
}
