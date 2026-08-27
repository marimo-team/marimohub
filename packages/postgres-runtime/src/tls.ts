import type { PostgresTlsCapability } from '@marimo-hub/core';

const MAX_CA_BYTES = 1024 * 1024;

export function postgresSslOptions(
	tls: PostgresTlsCapability,
	mode: PostgresTlsCapability['mode'] = tls.mode,
) {
	if (mode === 'disable') return false;
	if (mode === 'prefer' || mode === 'require') return { rejectUnauthorized: false };
	if (tls.mode !== 'verify-ca' && tls.mode !== 'verify-full') {
		throw new Error('Invalid TLS configuration.');
	}
	const ca = tls.ca.kind === 'bundle' ? tls.ca.pem : undefined;
	if (ca !== undefined && Buffer.byteLength(ca) > MAX_CA_BYTES) {
		throw new Error('Invalid TLS configuration.');
	}
	return {
		...(ca === undefined ? {} : { ca }),
		rejectUnauthorized: true,
		...(mode === 'verify-ca' ? { checkServerIdentity: () => void 0 } : {}),
	};
}

export function postgresTlsUnavailable(error: unknown): boolean {
	if ((error as { marimohubTlsUnavailable?: unknown } | null)?.marimohubTlsUnavailable === true) {
		return true;
	}
	return (
		error instanceof Error &&
		/(?:does not support|not supported|unavailable).*(?:ssl|tls)|(?:ssl|tls).*(?:does not support|not supported|unavailable)/i.test(
			error.message,
		)
	);
}
