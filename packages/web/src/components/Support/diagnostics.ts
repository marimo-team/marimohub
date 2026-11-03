import { SUPPORT_LIMITS, supportPageUrl } from '@marimo-hub/core/support';
import type { operations } from '@marimo-hub/client';

export type SupportContext = NonNullable<
	operations['support.diagnostics.preview']['requestBody']
>['content']['application/json'];
export type SupportDiagnostics =
	operations['support.diagnostics.preview']['responses'][200]['content']['application/json']['data'];

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
