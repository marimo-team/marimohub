/**
 * CoreWeave AI Object Storage (CAIOS) credential broker — adapter implementing
 * the `CredentialBroker` port for Workload Identity Federation.
 *
 * Exchanges a hub-issued OIDC JWT for temporary CAIOS S3 credentials. The
 * exchange is a single GET authenticated SOLELY by the JWT — no pre-existing
 * CoreWeave access key is required, so nothing long-lived lives in the hub or
 * the sandbox:
 *
 *   GET <exchangeUrl>            (e.g. https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc/<id>)
 *   Authorization: <jwt>
 *   → { AccessKeyId, SecretAccessKey, Token, Expiration }
 *
 * CoreWeave validates the JWT against the issuer's OIDC discovery + JWKS (which
 * the hub publishes), derives the principal `role/<iss>:<sub>`, and returns
 * temporary credentials scoped by the bucket policy that references that role.
 *
 * NOTE: the exchange endpoint is NOT the OIDC issuer URL. The issuer
 * (`https://oidc.cks.coreweave.com/id/<uuid>`, or your hub) only publishes
 * discovery + JWKS; the credential exchange lives under `api.coreweave.com`.
 */
import { FetchError, ofetch } from 'ofetch';
import { z } from 'zod';
import type { CredentialBroker, TempS3Creds } from '@marimo-hub/core';

/** Default request timeout for the exchange (ms). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Successful CAIOS exchange response. `Token` is "" when there is no session token. */
const CaiosCredsSchema = z.object({
	AccessKeyId: z.string().min(1),
	SecretAccessKey: z.string().min(1),
	Token: z.string().optional(),
	Expiration: z.string().optional(),
});

/** CoreWeave error envelope, e.g. `{ code: 3, message: "...Invalid token", details: [] }`. */
const CaiosErrorSchema = z.object({ message: z.string() }).partial();

export interface CoreWeaveWifBrokerOptions {
	/**
	 * CoreWeave WIF credential endpoint — e.g.
	 * `https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc/<id>`.
	 */
	exchangeUrl: string;
	/** Override the request timeout (ms). */
	timeoutMs?: number;
}

/** Summarize a Zod failure as `path: message; …` (field names/types only, no values). */
function summarizeIssues(error: z.ZodError): string {
	return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

/** Status + CoreWeave's own error message (operational, carries no secret) — never the JWT. */
function describeExchangeError(err: unknown): string {
	if (!(err instanceof FetchError)) return '';
	const status = err.status ? ` (HTTP ${err.status})` : '';
	const parsed = CaiosErrorSchema.safeParse(err.data);
	const message = parsed.success && parsed.data.message ? `: ${parsed.data.message}` : '';
	return `${status}${message}`;
}

export class CoreWeaveWifBroker implements CredentialBroker {
	private readonly exchangeUrl: string;
	private readonly timeoutMs: number;

	constructor(options: CoreWeaveWifBrokerOptions) {
		let url: URL;
		try {
			url = new URL(options.exchangeUrl);
		} catch {
			throw new Error(
				`Invalid MARIMOHUB_WIF_COREWEAVE_EXCHANGE_URL: ${options.exchangeUrl} (not a URL).`,
			);
		}
		// Guard the common mix-up: `oidc.cks.coreweave.com/id/<uuid>` is the OIDC
		// ISSUER URL (it only serves discovery + JWKS), not the credential endpoint.
		if (url.hostname === 'oidc.cks.coreweave.com') {
			throw new Error(
				`MARIMOHUB_WIF_COREWEAVE_EXCHANGE_URL (${options.exchangeUrl}) is an OIDC issuer URL, ` +
					'not the credential endpoint. Use ' +
					'https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc/<id>.',
			);
		}
		this.exchangeUrl = options.exchangeUrl;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async exchange(jwt: string): Promise<TempS3Creds> {
		let raw: unknown;
		try {
			raw = await ofetch(this.exchangeUrl, {
				method: 'GET',
				// CAIOS authenticates the exchange by the JWT alone (raw, not `Bearer`).
				headers: { Authorization: jwt },
				responseType: 'json',
				timeout: this.timeoutMs,
				// The exchange MINTS short-lived credentials (a side effect), so retry only
				// statuses where the mint almost certainly did not happen: throttling (429)
				// and gateway unavailable/timeout (503/504). Do NOT retry 500/502, which can
				// mean the mint partially succeeded and would orphan a credential.
				retry: 2,
				retryDelay: 250,
				retryStatusCodes: [429, 503, 504],
			});
		} catch (err) {
			// Surface the status + CoreWeave's own message so a misconfig is debuggable;
			// never the JWT or any returned secret.
			throw new Error(`CAIOS credential exchange failed${describeExchangeError(err)}`);
		}

		const parsed = CaiosCredsSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(
				`CAIOS credential exchange returned an unexpected response shape (${summarizeIssues(
					parsed.error,
				)})`,
			);
		}
		const body = parsed.data;
		return {
			accessKeyId: body.AccessKeyId,
			secretAccessKey: body.SecretAccessKey,
			sessionToken: body.Token || undefined,
			expiration: body.Expiration,
		};
	}
}
