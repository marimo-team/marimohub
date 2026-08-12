import { parentPort } from 'node:worker_threads';
import { BlockingDuckDBEngine } from './engine.ts';
import type { RuntimeRequest, RuntimeResponse } from './protocol';

if (!parentPort) throw new Error('DuckDB-Wasm worker started without a parent port.');
const port = parentPort;

const engine = new BlockingDuckDBEngine();

port.on('message', (request: RuntimeRequest) => {
	void handle(request);
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
