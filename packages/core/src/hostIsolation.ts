import { parse } from 'tldts';

export function normalizeHostname(host: string): string {
	return new URL(`http://${host.trim()}`).hostname.toLowerCase().replace(/\.$/, '');
}

function isPublicSuffix(host: ReturnType<typeof parse>): boolean {
	return host.domain === null && (host.isIcann === true || host.isPrivate === true);
}

export function hostsShareCookieDomain(first: string, second: string): boolean {
	const a = normalizeHostname(first);
	const b = normalizeHostname(second);
	if (a === b) return true;
	// Private suffixes keep unrelated github.io tenants in separate cookie domains.
	const aDomain = parse(a, { allowPrivateDomains: true });
	const bDomain = parse(b, { allowPrivateDomains: true });
	if (aDomain.domain !== null && aDomain.domain === bDomain.domain) return true;
	return (
		(a.endsWith(`.${b}`) && !isPublicSuffix(bDomain) && !bDomain.isIp) ||
		(b.endsWith(`.${a}`) && !isPublicSuffix(aDomain) && !aDomain.isIp)
	);
}
