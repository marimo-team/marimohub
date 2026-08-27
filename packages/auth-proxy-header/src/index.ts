import { createRemoteJWKSet, jwtVerify } from 'jose';
import { UserId } from '@marimo-hub/core';
import type { Authenticator, AuthUser } from '@marimo-hub/core';

const DEFAULT_HEADERS = ['X-Forwarded-Email', 'X-Forwarded-User'] as const;
const DEFAULT_IAP_HEADER = 'X-Goog-IAP-JWT-Assertion';
const DEFAULT_IAP_ISSUER = 'https://cloud.google.com/iap';
const DEFAULT_IAP_JWKS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
const MAX_EMAIL_LENGTH = 320;
const MAX_USER_ID_LENGTH = 512;

interface ProxyHeaderBaseConfig {
	allowedEmailDomains?: readonly string[];
}

export interface ProxyIdentityHeaderConfig extends ProxyHeaderBaseConfig {
	mode: 'headers';
	headers?: readonly [email: string, userId?: string];
}

export interface ProxyJwtConfig extends ProxyHeaderBaseConfig {
	mode: 'jwt';
	audience: string;
	header?: string;
	issuer?: string;
	jwksUrl?: string;
}

export type ProxyHeaderConfig = ProxyIdentityHeaderConfig | ProxyJwtConfig;

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function validEmail(value: string): boolean {
	if (
		value.length === 0 ||
		value.length > MAX_EMAIL_LENGTH ||
		hasControlCharacters(value) ||
		/\s/.test(value)
	) {
		return false;
	}
	const at = value.indexOf('@');
	return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1;
}

function validUserId(value: string): boolean {
	return value.length > 0 && value.length <= MAX_USER_ID_LENGTH && !hasControlCharacters(value);
}

function normalizeDomains(domains: readonly string[] | undefined): string[] {
	const normalized = (domains ?? [])
		.map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
		.filter(Boolean);
	return normalized.includes('*') ? [] : normalized;
}

function emailAllowed(email: string, domains: readonly string[]): boolean {
	if (domains.length === 0) return true;
	return domains.includes(email.slice(email.lastIndexOf('@') + 1).toLowerCase());
}

function checkedHttpsUrl(value: string): URL {
	try {
		const url = new URL(value);
		if (url.protocol === 'https:' && !url.username && !url.password) return url;
	} catch {
		// Use one operator-facing error for malformed and unsafe URLs.
	}
	throw new Error('Proxy JWT JWKS URL must be an HTTPS URL without credentials');
}

export class ProxyHeaderAuthenticator implements Authenticator {
	private readonly allowedDomains: string[];
	private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

	constructor(private readonly config: ProxyHeaderConfig) {
		this.allowedDomains = normalizeDomains(config.allowedEmailDomains);
		if (config.mode === 'jwt') {
			this.jwks = createRemoteJWKSet(checkedHttpsUrl(config.jwksUrl ?? DEFAULT_IAP_JWKS_URL));
		}
	}

	async authenticate(request: Request): Promise<AuthUser | null> {
		if (this.config.mode === 'headers') {
			const [emailHeader, userIdHeader] = this.config.headers ?? DEFAULT_HEADERS;
			const email = request.headers.get(emailHeader)?.trim() ?? '';
			const userId = request.headers.get(userIdHeader ?? emailHeader)?.trim() ?? '';
			return this.user(email, userId);
		}

		const assertion = request.headers.get(this.config.header ?? DEFAULT_IAP_HEADER);
		if (!assertion) return null;
		try {
			const { payload } = await jwtVerify(assertion, this.jwks!, {
				algorithms: ['ES256'],
				issuer: this.config.issuer ?? DEFAULT_IAP_ISSUER,
				audience: this.config.audience,
				clockTolerance: 30,
				maxTokenAge: '10 minutes',
			});
			if (
				typeof payload.sub !== 'string' ||
				typeof payload.email !== 'string' ||
				typeof payload.exp !== 'number' ||
				typeof payload.iat !== 'number'
			) {
				return null;
			}
			return this.user(payload.email.trim(), payload.sub.trim());
		} catch (error) {
			console.error(
				'Proxy JWT verification failed',
				error instanceof Error ? error.message : String(error),
			);
			return null;
		}
	}

	private user(email: string, userId: string): AuthUser | null {
		if (!validEmail(email) || !validUserId(userId) || !emailAllowed(email, this.allowedDomains)) {
			return null;
		}
		return { id: UserId.parse(userId), email };
	}
}
