import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, ApiRequestError } from './client';
import { SessionKeptRunningError, stopSessionSafely } from './sessionStop';
import type { Session } from '@/types';

const retained = {
	session_id: 'session',
	status: 'running',
	stop: {
		id: 'prior',
		outcome: 'retained',
		runtime_state: 'running',
		failure: { code: 'SOURCE_MISSING', retryable: false },
	},
} as Session;
const success = (status = 200) =>
	({ data: { success: true }, response: new Response(null, { status }) }) as never;
const state = (session: Session) =>
	({
		data: { success: true, data: session },
		response: new Response(null, { status: 200 }),
	}) as never;
const failed = () =>
	new ApiRequestError('SESSION_PERSISTENCE_REQUIRED', 'Retained', { status: 409 });

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('safe session stop decisions', () => {
	it('keeps the same session after a retained failure without another mutation', async () => {
		const stop = vi.spyOn(apiClient, 'DELETE').mockRejectedValue(failed());
		vi.spyOn(apiClient, 'GET').mockResolvedValue(state(retained));
		await expect(stopSessionSafely('p', 'n', 's', async () => 'keep')).rejects.toBeInstanceOf(
			SessionKeptRunningError,
		);
		expect(stop).toHaveBeenCalledOnce();
	});

	it.each(['retry', 'force'] as const)(
		'uses a new request identity and observed predecessor for %s',
		async (choice) => {
			const stop = vi
				.spyOn(apiClient, 'DELETE')
				.mockRejectedValueOnce(failed())
				.mockResolvedValueOnce(success());
			vi.spyOn(apiClient, 'GET').mockResolvedValue(state(retained));
			await stopSessionSafely('p', 'n', 's', async () => choice);
			const first = (
				stop.mock.calls[0][1] as unknown as {
					params: { header?: { 'idempotency-key'?: string }; query?: Record<string, unknown> };
				}
			).params;
			const second = (
				stop.mock.calls[1][1] as unknown as {
					params: { header?: { 'idempotency-key'?: string }; query?: Record<string, unknown> };
				}
			).params;
			expect(second.header?.['idempotency-key']).not.toBe(first.header?.['idempotency-key']);
			expect(second.query).toMatchObject({
				previous_attempt_id: 'prior',
				force: choice === 'force' ? 'true' : 'false',
			});
		},
	);

	it.each(['lost reply', 'accepted'] as const)(
		'polls %s without sending another stop or offering force while pending',
		async (kind) => {
			vi.useFakeTimers();
			const stop = vi.spyOn(apiClient, 'DELETE');
			if (kind === 'lost reply') stop.mockRejectedValueOnce(new Error('network disconnected'));
			else stop.mockResolvedValueOnce(success(202));
			vi.spyOn(apiClient, 'GET')
				.mockResolvedValueOnce(
					state({ ...retained, stop: { ...retained.stop!, outcome: 'capturing' } }),
				)
				.mockResolvedValueOnce(
					state({ ...retained, stop: { ...retained.stop!, outcome: 'stopped' } }),
				);
			const decision = vi.fn();
			const completed = stopSessionSafely('p', 'n', 's', decision);
			await vi.advanceTimersByTimeAsync(1000);
			await completed;
			expect(stop).toHaveBeenCalledOnce();
			expect(decision).not.toHaveBeenCalled();
		},
	);

	it('treats a missing session during reconciliation as stopped', async () => {
		vi.spyOn(apiClient, 'DELETE').mockResolvedValue(success(202));
		vi.spyOn(apiClient, 'GET').mockResolvedValue({
			error: { success: false, error: { code: 'NOT_FOUND', message: 'Gone' } },
			response: new Response(null, { status: 404 }),
		} as never);
		await expect(stopSessionSafely('p', 'n', 's')).resolves.toBeUndefined();
	});
	it('ends bounded pending polling without another mutation or a force decision', async () => {
		vi.useFakeTimers();
		const stop = vi.spyOn(apiClient, 'DELETE').mockResolvedValue(success(202));
		const get = vi
			.spyOn(apiClient, 'GET')
			.mockResolvedValue(state({ ...retained, stop: { ...retained.stop!, outcome: 'capturing' } }));
		const decision = vi.fn();
		const rejected = expect(stopSessionSafely('p', 'n', 's', decision)).rejects.toThrow(
			'still in progress',
		);
		await vi.advanceTimersByTimeAsync(120_000);
		await rejected;
		expect(get).toHaveBeenCalledTimes(120);
		expect(stop).toHaveBeenCalledOnce();
		expect(decision).not.toHaveBeenCalled();
	});

	it('does not repeat a lost mutation when status reconciliation is unavailable', async () => {
		const stop = vi.spyOn(apiClient, 'DELETE').mockRejectedValue(new Error('Lost reply'));
		const unavailable = new Error('Status unavailable');
		const get = vi.spyOn(apiClient, 'GET').mockRejectedValue(unavailable);
		const decision = vi.fn();
		await expect(stopSessionSafely('p', 'n', 's', decision)).rejects.toMatchObject({
			code: 'NETWORK_ERROR',
			message: unavailable.message,
		});
		expect(stop).toHaveBeenCalledOnce();
		expect(get).toHaveBeenCalledOnce();
		expect(decision).not.toHaveBeenCalled();
	});
});
