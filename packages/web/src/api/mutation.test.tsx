import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { renderHookWithClient } from '@/test/render';
import { useApiMutation, useInvalidate } from './mutation';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** The query keys passed to `invalidateQueries`, in call order. */
function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[] {
	return spy.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey);
}

describe('useInvalidate', () => {
	it('invalidates every key it is given', async () => {
		const { result, client } = renderHookWithClient(() => useInvalidate(), { toaster: false });
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			result.current(['a'], ['b', { id: 1 }]);
		});

		expect(invalidatedKeys(spy)).toEqual([['a'], ['b', { id: 1 }]]);
	});

	it('is a no-op with zero keys', async () => {
		const { result, client } = renderHookWithClient(() => useInvalidate(), { toaster: false });
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			result.current();
		});

		expect(spy).not.toHaveBeenCalled();
	});

	it('keeps a stable identity across renders', () => {
		const { result, rerender } = renderHookWithClient(() => useInvalidate(), { toaster: false });
		const first = result.current;

		rerender();

		expect(result.current).toBe(first);
	});
});

describe('useApiMutation', () => {
	it('resolves the mutationFn data through to the caller', async () => {
		const { result } = renderHookWithClient(
			() => useApiMutation(async (n: number) => ({ doubled: n * 2 })),
			{ toaster: false },
		);

		let data: { doubled: number } | undefined;
		await act(async () => {
			data = await result.current.mutateAsync(21);
		});

		expect(data).toEqual({ doubled: 42 });
		await waitFor(() => expect(result.current.data).toEqual({ doubled: 42 }));
	});

	it('invalidates the declared keys on success', async () => {
		const { result, client } = renderHookWithClient(
			() =>
				useApiMutation(
					async () => 'ok',
					() => [['things'], ['other']],
				),
			{ toaster: false },
		);
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await result.current.mutateAsync();
		});

		expect(invalidatedKeys(spy)).toEqual([['things'], ['other']]);
	});

	it('invalidates nothing when the mutationFn rejects', async () => {
		const { result, client } = renderHookWithClient(
			() =>
				useApiMutation(
					async () => {
						throw new Error('boom');
					},
					() => [['things']],
				),
			{ toaster: false },
		);
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await expect(result.current.mutateAsync()).rejects.toThrow('boom');
		});

		expect(spy).not.toHaveBeenCalled();
		await waitFor(() => expect(result.current.isError).toBe(true));
	});

	it('invalidates nothing when no keys callback is given', async () => {
		const { result, client } = renderHookWithClient(() => useApiMutation(async () => 'ok'), {
			toaster: false,
		});
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await result.current.mutateAsync();
		});

		expect(spy).not.toHaveBeenCalled();
	});

	it('passes both the variables and the returned data to the keys callback', async () => {
		const invalidates = vi.fn(
			(variables: { id: string }, data: { serverId: string }) =>
				[
					['by-variable', variables.id],
					['by-data', data.serverId],
				] as const,
		);
		const { result, client } = renderHookWithClient(
			() =>
				useApiMutation(
					async (variables: { id: string }) => ({ serverId: `srv-${variables.id}` }),
					invalidates,
				),
			{ toaster: false },
		);
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await result.current.mutateAsync({ id: 'a1' });
		});

		expect(invalidates).toHaveBeenCalledWith({ id: 'a1' }, { serverId: 'srv-a1' });
		expect(invalidatedKeys(spy)).toEqual([
			['by-variable', 'a1'],
			['by-data', 'srv-a1'],
		]);
	});
});
