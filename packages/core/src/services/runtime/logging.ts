import type { LoggingDestination } from '../../ports/integrations';
import { shellQuote } from './shell';
import { LOGGING_BOOTSTRAP, LOGGING_SITE_CUSTOMIZE } from './loggingBootstrap';

export const LOGGING_PACKAGES = [
	'opentelemetry-sdk==1.40.0',
	'opentelemetry-exporter-otlp-proto-http==1.40.0',
] as const;

export function loggingDirectory(sandboxId: string): string {
	return `/tmp/marimohub-logging/${sandboxId}`;
}

export function loggingFiles(
	destinations: LoggingDestination[],
	context: { sandboxId: string; notebookId: string; mode: string },
): { path: string; content: string }[] {
	const directory = loggingDirectory(context.sandboxId);
	return [
		{ path: `${directory}/sitecustomize.py`, content: LOGGING_SITE_CUSTOMIZE },
		{ path: `${directory}/marimohub_logging.py`, content: LOGGING_BOOTSTRAP },
		{
			path: `${directory}/logging.json`,
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
