import { logEvent } from './log';

function errorFields(value: unknown): { error: string; name?: string; stack?: string } {
	return value instanceof Error
		? { error: value.message, name: value.name, stack: value.stack }
		: { error: String(value) };
}

export function installProcessErrorHandlers(): void {
	// Some SDKs reject after an awaited call returns. Log the rejection and keep serving.
	process.on('unhandledRejection', (reason) => {
		logEvent({
			level: 'error',
			event: 'unhandled_rejection',
			...errorFields(reason),
		});
	});

	// A synchronous exception can corrupt shared process state.
	process.on('uncaughtException', (err) => {
		logEvent({
			level: 'error',
			event: 'uncaught_exception',
			...errorFields(err),
		});
		process.exit(1);
	});
}
