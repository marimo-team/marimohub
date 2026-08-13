export type HttpUrlProtocol = 'http:' | 'https:';

export type HttpUrlParseResult =
	| { ok: true; url: URL }
	| { ok: false; issue: 'invalid' | 'protocol' | 'credentials' | 'hostname' };

export interface ParseHttpUrlOptions {
	protocols?: readonly HttpUrlProtocol[];
	allowCredentials?: boolean;
}

export function parseHttpUrl(value: string, options: ParseHttpUrlOptions = {}): HttpUrlParseResult {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, issue: 'invalid' };
	}
	const protocols = options.protocols ?? ['http:', 'https:'];
	if (!protocols.includes(url.protocol as HttpUrlProtocol)) {
		return { ok: false, issue: 'protocol' };
	}
	if (!url.hostname) return { ok: false, issue: 'hostname' };
	if (!options.allowCredentials && (url.username !== '' || url.password !== '')) {
		return { ok: false, issue: 'credentials' };
	}
	return { ok: true, url };
}

export function requireHttpsUrl(value: string, label: string): string {
	const parsed = parseHttpUrl(value, { protocols: ['https:'] });
	if (!parsed.ok && parsed.issue === 'protocol') throw new Error(`${label} must use HTTPS`);
	if (!parsed.ok) throw new Error(`Invalid ${label}`);
	return value;
}
