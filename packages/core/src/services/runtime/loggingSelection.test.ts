import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { LOGGING_BOOTSTRAP } from './loggingBootstrap';

const python = process.env.MARIMO_INTEGRATION_PYTHON;

it.runIf(Boolean(python))(
	'selects logger namespaces independently before encoding and preserves legacy delivery',
	async () => {
		const directory = await mkdtemp(join(tmpdir(), 'mhub-logging-selection-'));
		try {
			await writeFile(join(directory, 'marimohub_logging.py'), LOGGING_BOOTSTRAP);
			const fixture = fileURLToPath(new URL('./fixtures/logging_selection.py', import.meta.url));
			const { stdout } = await promisify(execFile)(python!, [fixture, directory], {
				timeout: 30_000,
			});
			expect(JSON.parse(stdout)).toEqual({ ok: true });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
