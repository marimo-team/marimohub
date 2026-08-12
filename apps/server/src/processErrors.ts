import { logEvent } from './log';

export function installProcessErrorHandlers(): void {
	// Some SDKs reject after an awaited call returns. Log the rejection and keep serving.
	process.on('unhandledRejection', (reason) => {
		logEvent({
			level: 'error',
			event: 'unhandled_rejection',
			error: reason instanceof Error ? reason.message : String(reason),
			name: reason instanceof Error ? reason.name : undefined,
			stack: reason instanceof Error ? reason.stack : undefined,
		});
	});

	// A synchronous exception can corrupt shared process state.
	process.on('uncaughtException', (err) => {
		logEvent({
			level: 'error',
			event: 'uncaught_exception',
			error: err.message,
			name: err.name,
			stack: err.stack,
		});
		process.exit(1);
	});
}
