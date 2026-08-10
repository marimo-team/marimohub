import { describe, it, expect, vi, afterEach } from 'vitest';
import { toast } from 'sonner';
import { ApiRequestError } from '@/api/client';
import { errorMessage, toastError } from './errors';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('errorMessage', () => {
	it('reads the message off an Error', () => {
		expect(errorMessage(new Error('boom'))).toBe('boom');
	});

	it('carries the server message through an ApiRequestError', () => {
		expect(errorMessage(new ApiRequestError('FORBIDDEN', 'Not your project'))).toBe(
			'Not your project',
		);
	});

	it('passes a non-empty string through', () => {
		expect(errorMessage('plain failure')).toBe('plain failure');
	});

	it('falls back for anything without a message', () => {
		expect(errorMessage(undefined)).toBe('Something went wrong');
		expect(errorMessage(null)).toBe('Something went wrong');
		expect(errorMessage('')).toBe('Something went wrong');
		expect(errorMessage({ code: 500 })).toBe('Something went wrong');
	});
});

describe('toastError', () => {
	it('surfaces the message as an error toast', () => {
		const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
		toastError(new Error('could not save'));
		expect(error).toHaveBeenCalledWith('could not save');
	});

	it('uses recovery guidance for stale writes', () => {
		const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
		toastError(new ApiRequestError('PRECONDITION_FAILED', 'stale revision'));
		expect(error).toHaveBeenCalledWith('Someone else changed this item. Reload it and try again.');
	});
});
