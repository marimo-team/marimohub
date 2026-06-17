import React, { createContext, useContext, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUserQuery } from '../api/hooks';
import { userKeys } from '../api/queryKeys';
import type { User } from '../types';

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

	// Full-page navigation to the server's OIDC entry point, which redirects to
	// the IdP and (after the callback sets the session cookie) back to `/`.
	const signIn = useCallback(() => {
		window.location.href = '/api/auth/login';
	}, []);

	const signOut = useCallback(() => {
		if (user?.logout_url) {
			window.location.href = user.logout_url;
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
