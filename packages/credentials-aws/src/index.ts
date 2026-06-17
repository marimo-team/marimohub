/**
 * AWS STS credential broker — adapter implementing the `CredentialBroker` port
 * for Workload Identity Federation.
 *
 * Exchanges a hub-issued OIDC JWT for temporary AWS credentials via
 * `AssumeRoleWithWebIdentity`. The call is UNSIGNED — the JWT is the sole
 * credential — so nothing long-lived lives in the hub or the sandbox:
 *
 *   POST <stsUrl>                  (default https://sts.amazonaws.com)
 *   Action=AssumeRoleWithWebIdentity&Version=2011-06-15
 *     &RoleArn=<roleArn>&RoleSessionName=<sub>&WebIdentityToken=<jwt>
 *
 * STS validates the JWT against the issuer's OIDC discovery + JWKS (which the
 * hub publishes) and the role's trust policy — which must trust the hub as an
 * IAM OIDC identity provider and pin the token's `aud` (and optionally `sub`,
 * the project id). The returned credentials carry whatever the role's
 * permission policies allow (S3, Athena, …); their lifetime is the STS default
 * (1h) capped by the role's MaxSessionDuration — matching the hub's ~1h JWT.
 */
import { FetchError, ofetch } from 'ofetch';
import { z } from 'zod';
import type { CredentialBroker, TempS3Creds } from '@marimo-hub/core';

/** Default request timeout for the exchange (ms). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Global STS endpoint; operators should prefer a regional one (lower latency, isolation). */
const DEFAULT_STS_URL = 'https://sts.amazonaws.com';

/** RoleSessionName fallback when the JWT `sub` is unusable. */
const FALLBACK_SESSION_NAME = 'marimohub-wif';

/**
 * Successful response with `Accept: application/json` — the Query-protocol XML
 * transliterated. `Expiration` is epoch SECONDS (a number) in JSON mode, unlike
 * the ISO-8601 string the XML form carries.
 */
const StsCredsSchema = z.object({
	AssumeRoleWithWebIdentityResponse: z.object({
		AssumeRoleWithWebIdentityResult: z.object({
			Credentials: z.object({
				AccessKeyId: z.string().min(1),
				SecretAccessKey: z.string().min(1),
				SessionToken: z.string().min(1),
				Expiration: z.union([z.number(), z.string()]).optional(),
			}),
		}),
	}),
});

/** STS error envelope in JSON mode, e.g. `{ Error: { Code, Message, Type }, RequestId }`. */
const StsErrorSchema = z
	.object({ Error: z.object({ Code: z.string(), Message: z.string() }).partial() })
	.partial();

export interface AwsStsWifBrokerOptions {
	/** IAM role the JWT assumes, e.g. `arn:aws:iam::123456789012:role/marimohub-wif`. */
	roleArn: string;
	/** STS endpoint. Defaults to the global one; prefer regional (`https://sts.<region>.amazonaws.com`). */
	stsUrl?: string;
	/** Override the request timeout (ms). */
	timeoutMs?: number;
}

/** Summarize a Zod failure as `path: message; …` (field names/types only, no values). */
function summarizeIssues(error: z.ZodError): string {
	return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

/** Status + STS's own error code/message (operational, carries no secret) — never the JWT. */
function describeExchangeError(err: unknown): string {
	if (!(err instanceof FetchError)) return '';
	const status = err.status ? ` (HTTP ${err.status})` : '';
	// JSON envelope when STS honored the Accept header; XML from some error/proxy paths.
	const parsed = StsErrorSchema.safeParse(err.data);
	if (
		parsed.success &&
		parsed.data.Error &&
		(parsed.data.Error.Code || parsed.data.Error.Message)
	) {
		const { Code, Message } = parsed.data.Error;
		return `${status}: ${[Code, Message].filter(Boolean).join(' — ')}`;
	}
	if (typeof err.data === 'string') {
		const code = /<Code>([^<]*)<\/Code>/.exec(err.data)?.[1];
		const message = /<Message>([^<]*)<\/Message>/.exec(err.data)?.[1];
		if (code || message) return `${status}: ${[code, message].filter(Boolean).join(' — ')}`;
	}
	return status;
}

/**
 * RoleSessionName from the JWT `sub` (the project id) for CloudTrail
 * attribution. Decoded UNVERIFIED — it is the hub's own token and STS
 * independently verifies the signature; the name is cosmetic.
 */
function sessionNameFromJwt(jwt: string): string {
	try {
		const payload = jwt.split('.')[1] ?? '';
		const b64 = payload.replaceAll('-', '+').replaceAll('_', '/');
		const claims: unknown = JSON.parse(atob(b64));
		const sub = (claims as { sub?: unknown }).sub;
		if (typeof sub !== 'string') return FALLBACK_SESSION_NAME;
		// STS session-name charset: [\w+=,.@-], 2-64 chars.
		const sanitized = sub.replaceAll(/[^\w+=,.@-]/g, '-').slice(0, 64);
		return sanitized.length >= 2 ? sanitized : FALLBACK_SESSION_NAME;
	} catch {
		return FALLBACK_SESSION_NAME;
	}
}

/** Normalize the JSON-mode epoch-seconds `Expiration` to ISO-8601. */
function toIsoExpiration(expiration: number | string | undefined): string | undefined {
	if (typeof expiration === 'number') return new Date(expiration * 1000).toISOString();
	return expiration;
}

export class AwsStsWifBroker implements CredentialBroker {
	private readonly roleArn: string;
	private readonly stsUrl: string;
	private readonly timeoutMs: number;

	constructor(options: AwsStsWifBrokerOptions) {
		// `aws`, `aws-cn`, and `aws-us-gov` partitions.
		if (!/^arn:aws[\w-]*:iam::\d{12}:role\/.+/.test(options.roleArn)) {
			throw new Error(
				`Invalid MARIMOHUB_WIF_AWS_ROLE_ARN: ${options.roleArn} ` +
					'(expected arn:aws:iam::<account-id>:role/<name>).',
			);
		}
		const stsUrl = options.stsUrl ?? DEFAULT_STS_URL;
		try {
			new URL(stsUrl);
		} catch {
			throw new Error(`Invalid MARIMOHUB_WIF_AWS_STS_URL: ${stsUrl} (not a URL).`);
		}
		this.roleArn = options.roleArn;
		this.stsUrl = stsUrl;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async exchange(jwt: string): Promise<TempS3Creds> {
		const form = new URLSearchParams({
			Action: 'AssumeRoleWithWebIdentity',
			Version: '2011-06-15',
			RoleArn: this.roleArn,
			RoleSessionName: sessionNameFromJwt(jwt),
			WebIdentityToken: jwt,
		});

		let raw: unknown;
		try {
			raw = await ofetch(this.stsUrl, {
				method: 'POST',
				// Explicit content-type so ofetch sends the string as-is (no JSON encoding);
				// Accept flips the Query protocol's XML response to JSON.
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					accept: 'application/json',
				},
				body: form.toString(),
				responseType: 'json',
				timeout: this.timeoutMs,
				// The exchange MINTS short-lived credentials (a side effect), so retry only
				// statuses where the mint almost certainly did not happen: throttling (429)
				// and gateway unavailable/timeout (503/504). Do NOT retry 500/502, which can
				// mean the mint partially succeeded. STS throttling surfaces as HTTP 400
				// `Throttling` on the Query API and is deliberately not retried either.
				retry: 2,
				retryDelay: 250,
				retryStatusCodes: [429, 503, 504],
			});
		} catch (err) {
			// Surface the status + STS's own code/message so a misconfig (trust policy,
			// audience, clock skew) is debuggable; never the JWT or any returned secret.
			throw new Error(`STS credential exchange failed${describeExchangeError(err)}`);
		}

		const parsed = StsCredsSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(
				`STS credential exchange returned an unexpected response shape (${summarizeIssues(
					parsed.error,
				)})`,
			);
		}
		const creds =
			parsed.data.AssumeRoleWithWebIdentityResponse.AssumeRoleWithWebIdentityResult.Credentials;
		return {
			accessKeyId: creds.AccessKeyId,
			secretAccessKey: creds.SecretAccessKey,
			sessionToken: creds.SessionToken,
			expiration: toIsoExpiration(creds.Expiration),
		};
	}
}
