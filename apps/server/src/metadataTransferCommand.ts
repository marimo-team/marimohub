import { MetadataTransferError } from '@marimo-hub/core/errors';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadAdapterLibraries, makeStorage } from '@marimo-hub/config';
import { metadataPostgresUrl } from '@marimo-hub/config/metadata';
import { runMetadataTransfer } from '@marimo-hub/config/metadata.node';

const Input = z.strictObject({
	namespace: z.string().min(1),
	id: z.uuid(),
	pageSize: z.number().int().min(1).max(1000).optional(),
	fresh: z.boolean().optional(),
	direction: z.enum(['bucket_to_sql', 'sql_to_bucket']).optional(),
});
export async function metadataTransferCommand(activate: boolean): Promise<void> {
	const { values } = parseArgs({
		options: {
			input: { type: 'string' },
			'writers-stopped': { type: 'boolean' },
			abort: { type: 'boolean' },
		},
	});
	if (!values.input || !values['writers-stopped'])
		throw new Error(
			'Required: --input <file.json> --writers-stopped [--abort]. Stop and externally fence all writers first.',
		);
	const abort = values.abort === true;
	if (abort && activate) throw new Error('Abort with metadata:transfer, not metadata:activate');
	const options = Input.parse(JSON.parse(await readFile(values.input, 'utf8')));
	const url = metadataPostgresUrl(process.env, 'MARIMOHUB_METADATA_ADMIN_POSTGRES_URL', true);
	const libraries = await loadAdapterLibraries(process.env);
	const bucket = makeStorage(process.env, libraries);
	try {
		console.log(
			JSON.stringify(
				await runMetadataTransfer(url, bucket, {
					...options,
					writersStopped: true,
					activate,
					abort,
				}),
			),
		);
	} catch (error) {
		if (error instanceof MetadataTransferError) throw error;
		// Driver and schema errors can contain record data or connection credentials.
		throw new Error(
			'Metadata transfer stopped. Keep writers fenced; inspect transfer state before resuming with the same ID.',
		);
	}
}
