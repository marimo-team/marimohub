import { parentPort } from 'node:worker_threads';
import { BlockingDuckDBEngine } from './engine.ts';
import type { RuntimeRequest, RuntimeResponse } from './protocol';

if (!parentPort) throw new Error('DuckDB-Wasm worker started without a parent port.');
const port = parentPort;

const engine = new BlockingDuckDBEngine();
let requestQueue = Promise.resolve();

port.on('message', (request: RuntimeRequest) => {
	requestQueue = requestQueue
		.then(
			() => handle(request),
			() => handle(request),
		)
		.catch(() => {});
});

async function handle(request: RuntimeRequest): Promise<void> {
	let response: RuntimeResponse;
	try {
		switch (request.type) {
			case 'initialize':
				await engine.initialize(request.memoryLimitMb);
				response = { id: request.id, ok: true };
				break;
			case 'execute':
				response = { id: request.id, ok: true, value: engine.execute(request.program) };
				break;
			case 'execute-query':
				response = { id: request.id, ok: true, value: await engine.executeQuery(request.request) };
				break;
			case 'ping':
				engine.ping();
				response = { id: request.id, ok: true };
				break;
		}
	} catch (error) {
		response = {
			id: request.id,
			ok: false,
			error: error instanceof Error ? error.message : 'DuckDB-Wasm worker failed.',
		};
	}
	port.postMessage(response);
}
