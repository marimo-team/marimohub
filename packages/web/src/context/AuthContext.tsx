import React, { createContext, useContext, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUserQuery } from '../api/hooks';
import { userKeys } from '../api/queryKeys';
import type { User } from '../types';
import { withBasePath } from '../lib/basePath';

interface AuthContextValue {
	user: User | null;
	isPending: boolean;
	error: Error | null;
	signIn: () => void;
	signOut: () => void;
	refetchUser: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
	const queryClient = useQueryClient();
	const { data: user, isPending, error } = useUserQuery();

	// Full-page navigation to the server's OIDC entry point. The current SPA
	// location rides along as `redirect_url` so the deep link survives the IdP
	// round-trip; the server sanitizes it to a same-origin path (open-redirect
	// guard), falling back to `/`.
	const signIn = useCallback(() => {
		const params = new URLSearchParams(window.location.search);
		// Drop a stale error from a previous failed attempt so it doesn't resurface
		// after a successful sign-in.
		params.delete('auth_error');
		const search = params.toString();
		const returnTo = window.location.pathname + (search ? `?${search}` : '') + window.location.hash;
		window.location.href =
			returnTo === '/'
				? withBasePath('/api/auth/login')
				: withBasePath(`/api/auth/login?redirect_url=${encodeURIComponent(returnTo)}`);
	}, []);

	const signOut = useCallback(() => {
		if (user?.logout_url) {
			window.location.href = withBasePath(user.logout_url);
		} else {
			queryClient.setQueryData(userKeys.me(), null);
		}
	}, [user?.logout_url, queryClient]);

	const refetchUser = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey: userKeys.me() });
	}, [queryClient]);

	const value = useMemo<AuthContextValue>(
		() => ({
			user: user ?? null,
			isPending,
			error: error ?? null,
			signIn,
			signOut,
			refetchUser,
		}),
		[user, isPending, error, signIn, signOut, refetchUser],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
	const context = useContext(AuthContext);
	if (!context) {
		throw new Error('useAuth must be used within an AuthProvider');
	}
	return context;
}
