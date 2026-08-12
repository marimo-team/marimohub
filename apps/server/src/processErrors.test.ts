import { afterEach, describe, expect, it, vi } from 'vitest';
import { installProcessErrorHandlers } from './processErrors';

describe('process error handlers', () => {
	afterEach(() => vi.restoreAllMocks());

	it('logs a non-Error uncaught exception before exiting', () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		vi.spyOn(process, 'on').mockImplementation(((
			event: string,
			handler: (...args: unknown[]) => void,
		) => {
			handlers.set(event, handler);
			return process;
		}) as typeof process.on);
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		installProcessErrorHandlers();
		handlers.get('uncaughtException')?.(null);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			event: 'uncaught_exception',
			error: 'null',
		});
		expect(exit).toHaveBeenCalledWith(1);
	});
});
