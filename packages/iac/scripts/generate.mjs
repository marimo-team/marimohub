import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import openapiTS, { astToString } from 'openapi-typescript';
import { SAMPLE_CONFIGS } from '../../core/src/services/integrations/kinds/sampleConfigs.ts';

export async function generate() {
	const source = new URL('../../../internal/schemas/integrations.yml', import.meta.url);
	const document = await readFile(source, 'utf8');
	const kinds = [...document.matchAll(/^  \/kinds\/([a-z0-9_]+)\/config:/gm)]
		.map((match) => match[1])
		.sort();
	if (JSON.stringify(kinds) !== JSON.stringify(Object.keys(SAMPLE_CONFIGS).sort()))
		throw new Error('Integration kinds and compile samples differ. Add a sample for each kind.');
	const generated = astToString(
		await openapiTS(source, {
			defaultNonNullable: false,
			transform(schema) {
				if (schema['x-marimohub-secret']) return ts.factory.createTypeReferenceNode('SecretInput');
			},
		}),
	);
	return {
		types: `export type SecretInput = string | { $secret: { kind: 'reference'; backend: string; locator: string } } | { $secret: { kind: 'managed'; set: true } };\n${generated}\nexport type IntegrationConfigMap = {\n${kinds.map((kind) => `${JSON.stringify(kind)}: components['schemas'][${JSON.stringify(kind)}];`).join('\n')}\n};\n`,
		samples: `// Generated from the core kind samples; do not edit.\nimport type { IntegrationConfigMap } from './generated';\nexport const samples = ${JSON.stringify(SAMPLE_CONFIGS, null, '\t')} satisfies IntegrationConfigMap;\n`,
	};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const output = await generate();
	await writeFile(new URL('../src/generated.ts', import.meta.url), output.types);
	await writeFile(new URL('../src/samples.ts', import.meta.url), output.samples);
}
