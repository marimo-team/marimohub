import { z } from 'zod';
import { defineIntegration } from '../sdk';
import { boundedText } from '../text';

export const startupScript = defineIntegration({
	kind: 'startup_script',
	title: 'Startup script',
	description:
		'Run a shell script before notebook dependency setup on each new session or job run. A failed script stops startup.',
	category: 'other',
	brand: { color: '#64748B' },
	schemaVersion: 1,
	configSchema: z.strictObject({
		script: boundedText(64 * 1024, 'POSIX shell script run with sh -e from the workspace root')
			.min(1)
			.refine((value) => value.trim().length > 0 && !value.includes('\0'), {
				message: 'Script must contain shell commands and cannot contain NUL characters.',
			}),
	}),
	uiHints: {
		script: {
			widget: 'textarea',
			file_accept: ['.sh'],
			placeholder: '#!/bin/sh\necho "Starting notebook"\n',
		},
	},
	render({ config, instanceName }) {
		const path = `startup/${instanceName}.sh`;
		return {
			workspaceLoadMode: 'copy-only',
			files: [{ path, content: config.script.replaceAll('\r\n', '\n') }],
			startupScripts: [path],
		};
	},
});
