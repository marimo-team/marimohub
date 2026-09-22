import { parse } from 'tldts';
import { hasControlCharacter } from './internal/validation';

export function normalizeHostname(host: string): string {
	const value = host.trim();
	if (
		hasControlCharacter(value) ||
		/[\s\\/?#@]/.test(value) ||
		!/^(?:\[[^[\]]+\]|[^:[\]]+)(?::[0-9]+)?$/.test(value)
	) {
		throw new TypeError('Expected a hostname with an optional port');
	}
	return new URL(`http://${value}`).hostname.toLowerCase().replace(/\.$/, '');
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
