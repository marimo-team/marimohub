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

export function hostsOverlap(first: string, second: string): boolean {
	const a = normalizeHostname(first);
	const b = normalizeHostname(second);
	if (a === b) return true;
	// A public suffix is not a parent host, including private suffixes such as github.io.
	const aDomain = parse(a, { allowPrivateDomains: true });
	const bDomain = parse(b, { allowPrivateDomains: true });
	return (
		(a.endsWith(`.${b}`) && !isPublicSuffix(bDomain) && !bDomain.isIp) ||
		(b.endsWith(`.${a}`) && !isPublicSuffix(aDomain) && !aDomain.isIp)
	);
}
