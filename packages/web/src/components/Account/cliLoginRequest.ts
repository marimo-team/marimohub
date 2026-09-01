const STATE_RE = /^[A-Za-z0-9_-]{32,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export interface CliLoginRequest {
	callback: URL;
	state: string;
	codeChallenge: string;
}

function parseLoopbackCallback(raw: string): URL | null {
	try {
		const url = new URL(raw);
		return url.protocol === 'http:' &&
			(url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
			Boolean(url.port) &&
			!url.username &&
			!url.password &&
			url.pathname === '/callback' &&
			!url.search &&
			!url.hash
			? url
			: null;
	} catch {
		return null;
	}
}

export function parseCliLoginRequest(search: string): CliLoginRequest | null {
	const params = new URLSearchParams(search);
	const callbackUri = params.get('callback_uri');
	const state = params.get('state');
	const codeChallenge = params.get('code_challenge');
	const callback = callbackUri ? parseLoopbackCallback(callbackUri) : null;
	if (
		!callback ||
		!state ||
		!codeChallenge ||
		!STATE_RE.test(state) ||
		!CHALLENGE_RE.test(codeChallenge)
	) {
		return null;
	}
	return { callback, state, codeChallenge };
}

export function cancellationUrl(request: CliLoginRequest): string {
	request.callback.searchParams.set('error', 'access_denied');
	request.callback.searchParams.set('state', request.state);
	return request.callback.toString();
}
