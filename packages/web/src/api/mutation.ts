import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MutationMeta, QueryKey } from '@tanstack/react-query';

/** Keys are taken per call, so they may depend on a mutation's variables. */
export function useInvalidate(): (...keys: readonly QueryKey[]) => void {
	const queryClient = useQueryClient();
	return useCallback(
		(...keys: readonly QueryKey[]) => {
			for (const queryKey of keys) {
				void queryClient.invalidateQueries({ queryKey });
			}
		},
		[queryClient],
	);
}

/** `useMutation` that drops the keys `invalidates` names, on success only. */
export function useApiMutation<TData, TVariables = void>(
	mutationFn: (variables: TVariables) => Promise<TData>,
	invalidates?: (variables: TVariables, data: TData) => readonly QueryKey[],
	meta?: MutationMeta,
) {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn,
		meta,
		onSuccess: (data, variables) => {
			if (invalidates) invalidate(...invalidates(variables, data));
		},
	});
}
