import { Circle, LogIn, AlertCircle } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui';

/**
 * Human-readable messages for the `auth_error` codes the OIDC callback bounces
 * back to the SPA (see `callbackError` in `@marimo-hub/auth-oidc`). Anything not
 * listed falls back to a generic sign-in failure.
 */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
	domain_not_allowed:
		'That account isn’t allowed to access this marimohub. Sign in with an authorized email address.',
	email_not_verified:
		'Your email address isn’t verified with your identity provider. Verify it there, then try again.',
	session_expired: 'Your sign-in session expired before it completed. Please try again.',
	auth_failed: 'Sign-in failed. Please try again.',
};

/**
 * Unauthenticated landing screen. Shown by `AuthGate` when `/api/v1/me` returns
 * 401. The button does a full-page navigation to the server's OIDC login route.
 * When the OIDC callback rejected the attempt (e.g. a disallowed email domain),
 * it redirects here with `?auth_error=<code>`, which we surface inline.
 */
export function SignIn() {
	const { signIn } = useAuth();
	const [searchParams] = useSearchParams();
	const errorCode = searchParams.get('auth_error');
	const errorMessage = errorCode
		? (AUTH_ERROR_MESSAGES[errorCode] ?? AUTH_ERROR_MESSAGES.auth_failed)
		: null;

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-8 p-8">
			<div className="flex items-center gap-2 text-primary">
				<Circle className="size-6" />
				<span className="font-mono text-base font-semibold tracking-[2px]">MARIMOHUB</span>
			</div>

			<div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-lg border bg-background p-8 text-center shadow-sm">
				<div className="flex flex-col gap-1.5">
					<h1 className="text-lg font-semibold">Sign in</h1>
					<p className="text-sm text-muted-foreground">Sign in to access your notebooks.</p>
				</div>

				{errorMessage && (
					<div
						role="alert"
						className="flex w-full items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-left text-sm text-destructive"
					>
						<AlertCircle className="mt-0.5 size-4 shrink-0" />
						<span>{errorMessage}</span>
					</div>
				)}

				<Button variant="primary" size="md" onPress={signIn} className="w-full">
					<LogIn className="size-4" />
					{errorMessage ? 'Try a different account' : 'Sign in to continue'}
				</Button>
			</div>
		</div>
	);
}
