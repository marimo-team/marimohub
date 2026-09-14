type BearerAuthorization =
	| { kind: 'absent' }
	| { kind: 'invalid' }
	| { kind: 'bearer'; token: string };

const MAX_BEARER_TOKEN_LENGTH = 32768;
const BEARER_SCHEME = /^bearer(?:\s|$)/i;

export function parseBearerAuthorization(request: Request): BearerAuthorization {
	const header = request.headers.get('authorization');
	if (!header) return { kind: 'absent' };
	const values = header.split(',');
	if (!values.some((value) => BEARER_SCHEME.test(value.trim()))) return { kind: 'absent' };
	// Fetch joins duplicate Authorization fields; never choose between credentials.
	if (values.length !== 1) return { kind: 'invalid' };
	const match = /^bearer[ \t]+([a-z0-9._~+/-]+=*)$/i.exec(header);
	if (!match || match[1].length > MAX_BEARER_TOKEN_LENGTH) return { kind: 'invalid' };
	return { kind: 'bearer', token: match[1] };
}

export function bearerToken(request: Request): string | null {
	const parsed = parseBearerAuthorization(request);
	return parsed.kind === 'bearer' ? parsed.token : null;
}
