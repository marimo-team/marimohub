import { SUPPORT_LIMITS, supportPageUrl } from '@marimo-hub/core/support';
import type { operations } from '@marimo-hub/client';

export type SupportContext = NonNullable<
	operations['support.diagnostics']['requestBody']
>['content']['application/json'];
export type SupportDiagnostics =
	operations['support.diagnostics']['responses'][200]['content']['application/json']['data'];

export function clientSupportContext(
	session?: SupportContext['session'],
	error?: string,
): SupportContext {
	return {
		page_url: supportPageUrl(window.location.href),
		client: {
			user_agent: navigator.userAgent.slice(0, SUPPORT_LIMITS.userAgent),
			viewport: { width: window.innerWidth, height: window.innerHeight },
			...(error ? { error: error.slice(0, SUPPORT_LIMITS.clientError) } : {}),
		},
		...(session ? { session } : {}),
	};
}

export function supportPortalUrl(supportUrl: string, diagnostics: string): string | null {
	const bytes = new TextEncoder().encode(diagnostics);
	if (bytes.length > 4096) return null;
	const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
	if (encoded.length > 4096) return null;
	const url = new URL(supportUrl, window.location.origin);
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	url.searchParams.set('diagnostics', encoded);
	return url.href;
}
