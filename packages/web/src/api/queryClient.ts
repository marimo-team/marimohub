import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from './client';
import { userKeys } from './queryKeys';
import { toastError } from '@/lib/errors';

function isUnauthorized(error: unknown): boolean {
	return (
		error instanceof ApiRequestError && (error.status === 401 || error.code === 'UNAUTHORIZED')
	);
}

export function shouldRetryRequest(failureCount: number, error: unknown): boolean {
	if (failureCount >= 1) return false;
	if (
		error instanceof ApiRequestError &&
		error.status !== undefined &&
		error.status >= 400 &&
		error.status < 500
	) {
		return false;
	}
	return true;
}

export function createQueryClient(): QueryClient {
	const holder: { client?: QueryClient } = {};
	const handleError = (error: unknown) => {
		if (isUnauthorized(error)) holder.client?.setQueryData(userKeys.me(), null);
	};
	const client = new QueryClient({
		queryCache: new QueryCache({ onError: handleError }),
		mutationCache: new MutationCache({
			onError: (error, _variables, _context, mutation) => {
				handleError(error);
				if (mutation.options.meta?.suppressErrorToast !== true) toastError(error);
			},
		}),
		defaultOptions: {
			queries: {
				staleTime: 60_000,
				retry: shouldRetryRequest,
			},
		},
	});
	holder.client = client;
	return client;
}

export const queryClient = createQueryClient();
