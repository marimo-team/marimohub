import { logEvent } from './log';

export function installProcessErrorHandlers(): void {
	// Some provider SDKs can reject after their awaited call returned. Keep the
	// request-serving process alive and leave health checks to report real outages.
	process.on('unhandledRejection', (reason) => {
		logEvent({
			level: 'error',
			event: 'unhandled_rejection',
			error: reason instanceof Error ? reason.message : String(reason),
			name: reason instanceof Error ? reason.name : undefined,
			stack: reason instanceof Error ? reason.stack : undefined,
		});
	});

	// A synchronous exception can leave shared process state inconsistent.
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
