import React, { createContext, useContext, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUserQuery } from '../api/hooks';
import { userKeys } from '../api/queryKeys';
import type { User } from '../types';

interface AuthContextValue {
	user: User | null;
	isPending: boolean;
	error: Error | null;
	signOut: () => void;
	refetchUser: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
	const queryClient = useQueryClient();
	const { data: user, isPending, error } = useUserQuery();

	const signOut = useCallback(() => {
		if (user?.logoutUrl) {
			window.location.href = user.logoutUrl;
		} else {
			queryClient.setQueryData(userKeys.me(), null);
		}
	}, [user?.logoutUrl, queryClient]);

	const refetchUser = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: userKeys.me() });
	}, [queryClient]);

	const value = useMemo<AuthContextValue>(
		() => ({
			user: user ?? null,
			isPending,
			error: error ?? null,
			signOut,
			refetchUser,
		}),
		[user, isPending, error, signOut, refetchUser],
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
