import { parseArgs } from 'node:util';
import { makeStorage } from '@marimo-hub/config';
import { NotebookMoveService } from '@marimo-hub/core';

const { values } = parseArgs({ options: { 'writers-stopped': { type: 'boolean' } } });
if (!values['writers-stopped']) {
	throw new Error(
		'Stop API replicas, schedulers, maintenance, and sandbox writers, then pass --writers-stopped.',
	);
}
console.log(
	JSON.stringify(
		await NotebookMoveService.recover(makeStorage(process.env), { writersStopped: true }),
		null,
		2,
	),
);
