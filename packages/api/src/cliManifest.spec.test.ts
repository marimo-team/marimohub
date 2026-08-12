import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateCliManifest } from './cliManifest';
import { generateOpenApiDocument } from './createApi';

const manifestPath = fileURLToPath(
	new URL('../../../apps/cli/generated/cli-manifest.json', import.meta.url),
);

describe('CLI manifest', () => {
	it('matches the API contract', async () => {
		const manifest = generateCliManifest(generateOpenApiDocument());
		if (process.env.UPDATE_CLI_MANIFEST === '1') {
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
			return;
		}
		expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(manifest);
	});

	it('has a unique command for every documented operation', () => {
		const manifest = generateCliManifest(generateOpenApiDocument());
		expect(manifest.operations).toHaveLength(59);
		expect(new Set(manifest.operations.map((operation) => operation.id)).size).toBe(59);
	});
});
