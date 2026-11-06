import type { LoggingDestination } from '../../ports/integrations';
import { shellQuote } from './shell';
import { LOGGING_BOOTSTRAP, LOGGING_SITE_CUSTOMIZE } from './loggingBootstrap';

// Fixed rather than per sandbox, so each launch overwrites the previous credentials and a
// filesystem-snapshot restore does not accumulate stale tokens.
export const LOGGING_DIR = '/tmp/marimohub-logging';

export function loggingFiles(
	destinations: LoggingDestination[],
	context: { sandboxId: string; notebookId: string; mode: string },
): { path: string; content: string }[] {
	return [
		{ path: `${LOGGING_DIR}/sitecustomize.py`, content: LOGGING_SITE_CUSTOMIZE },
		{ path: `${LOGGING_DIR}/marimohub_logging.py`, content: LOGGING_BOOTSTRAP },
		{
			path: `${LOGGING_DIR}/logging.json`,
			content: JSON.stringify(
				destinations.map((destination) => ({
					...destination,
					attributes: {
						...destination.attributes,
						'marimohub.notebook_id': context.notebookId,
						'marimohub.sandbox_id': context.sandboxId,
						'marimohub.mode': context.mode,
					},
				})),
			),
		},
	];
}

export function loggingCommand(directory: string | undefined, command: string): string {
	if (!directory) return command;
	// Limit injection to the workload and its children, after uv resolves its overlay.
	return `env PYTHONPATH=${shellQuote(directory)}"\${PYTHONPATH:+:$PYTHONPATH}" ${command}`;
}
