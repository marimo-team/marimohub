import { parseArgs } from 'node:util';
import { makeStorage, storageBackend } from '@marimo-hub/config';
import { NotebookMoveService } from '@marimo-hub/core';

const { values } = parseArgs({ options: { 'writers-stopped': { type: 'boolean' } } });
if (!values['writers-stopped']) {
	throw new Error(
		'Stop API replicas, schedulers, maintenance, and sandbox writers, then pass --writers-stopped.',
	);
}
const backend = storageBackend(process.env);
if (!['s3', 'gcs', 'azure', 'fs'].includes(backend)) {
	throw new Error(
		'This command supports s3, gcs, azure, and fs storage. Other adapters can use NotebookMoveService.recover directly.',
	);
}

console.log(
	JSON.stringify(
		await NotebookMoveService.recover(makeStorage(process.env), { writersStopped: true }),
		null,
		2,
	),
);
