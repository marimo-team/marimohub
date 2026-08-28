import { z } from 'zod';
import { ValidationError } from '../../../errors';
import type { DuckDBDatabaseHttpAccess } from '../data-preview/programs';
import { basicAuthHeader } from '../sdk';
import { zSecret } from '../secretFields';

export const exactObjectAuthSchema = z.discriminatedUnion('method', [
	z.strictObject({ method: z.literal('none') }),
	z.strictObject({ method: z.literal('bearer_token'), token: zSecret() }),
	z.strictObject({
		method: z.literal('basic'),
		username: z
			.string()
			.min(1)
			.regex(/^[^:]+$/, 'Basic authentication username must not contain a colon'),
		password: zSecret(),
	}),
]);

type ExactObjectAuth = z.infer<typeof exactObjectAuthSchema>;

export function exactObjectAccess(url: string, auth: ExactObjectAuth): DuckDBDatabaseHttpAccess {
	const authorization = exactObjectAuthorization(auth);
	return {
		kind: 'http-database',
		url,
		...(authorization ? { authorization } : {}),
	};
}

export function normalizeExactObjectUrl(options: {
	url: string;
	allowedSuffixes: readonly string[];
	allowOtherSuffix: boolean;
	label: string;
}): string {
	const { url: input, allowedSuffixes, allowOtherSuffix, label } = options;
	if (hasRawDotSegment(input)) throw invalidUrl(label, allowedSuffixes);
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw invalidUrl(label, allowedSuffixes);
	}
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		url.hash !== '' ||
		input.includes('\\') ||
		/%(?:2f|5c)/i.test(url.pathname)
	) {
		throw invalidUrl(label, allowedSuffixes);
	}
	let path: string;
	try {
		path = decodeURIComponent(url.pathname).normalize('NFC');
	} catch {
		throw invalidUrl(label, allowedSuffixes);
	}
	if (
		path.endsWith('/') ||
		(!allowOtherSuffix && !allowedSuffixes.some((suffix) => path.endsWith(suffix)))
	) {
		throw invalidUrl(label, allowedSuffixes);
	}
	const canonicalPathname = path.split('/').map(encodeURIComponent).join('/');
	url.pathname = canonicalPathname;
	if (url.pathname !== canonicalPathname || hasEncodedPathSyntax(url.pathname)) {
		throw invalidUrl(label, allowedSuffixes);
	}
	return url.toString();
}

function exactObjectAuthorization(auth: ExactObjectAuth): string | undefined {
	switch (auth.method) {
		case 'none':
			return;
		case 'bearer_token':
			return `Bearer ${auth.token}`;
		case 'basic':
			return basicAuthHeader(auth.username, auth.password);
	}
}

function hasRawDotSegment(input: string): boolean {
	const match = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*(?<pathname>[^?#]*)/i.exec(input);
	const pathname = match?.groups?.pathname ?? input;
	return pathname.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

function hasEncodedPathSyntax(pathname: string): boolean {
	let current = pathname;
	for (;;) {
		if (/%(?:2f|5c)/i.test(current)) return true;
		let decoded: string;
		try {
			decoded = decodeURIComponent(current);
		} catch {
			return false;
		}
		if (decoded === current) return false;
		if (
			decoded.includes('\\') ||
			decoded.split('/').some((part) => part === '.' || part === '..')
		) {
			return true;
		}
		current = decoded;
	}
}

function invalidUrl(label: string, suffixes: readonly string[]): ValidationError {
	return new ValidationError(
		`${label} URL must be an exact HTTPS object URL without credentials, query parameters, ` +
			'fragments, encoded separators or dot segments, or a trailing slash. The path must end in ' +
			`${suffixes.join(', ')} unless the advanced suffix override is enabled.`,
	);
}
