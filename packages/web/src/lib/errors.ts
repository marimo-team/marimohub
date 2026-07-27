import { toast } from 'sonner';

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
	toast.error(errorMessage(err));
}
