import { toast } from 'sonner';
import { ApiRequestError } from '@/api/client';

/**
 * A displayable message for anything thrown. Rejections from the api hooks are
 * always `Error`s (`ApiRequestError` carries the server's message), but `catch`
 * binds `unknown`, so this narrows without the `(err as Error)` cast.
 */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return typeof err === 'string' && err ? err : 'Something went wrong';
}

export function toastError(err: unknown): void {
	if (err instanceof ApiRequestError && err.code === 'PRECONDITION_FAILED') {
		toast.error('Someone else changed this item. Reload it and try again.');
		return;
	}
	toast.error(errorMessage(err));
}
