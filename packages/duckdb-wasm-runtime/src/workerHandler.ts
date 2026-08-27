import { parentPort } from 'node:worker_threads';
import { DataQueryUserError } from '@marimo-hub/core/data-query-contracts';
import { BlockingDuckDBEngine } from './engine.ts';
import type { RuntimeRequest, RuntimeResponse } from './protocol';
import { createSyncXmlHttpRequest } from './syncXmlHttpRequest.ts';

if (!parentPort) throw new Error('DuckDB-Wasm worker started without a parent port.');
const port = parentPort;

Object.defineProperty(globalThis, 'XMLHttpRequest', {
	configurable: true,
	value: createSyncXmlHttpRequest({ port }),
});

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
				await engine.initialize(request.memoryLimitMb, request.httpEnabled);
				response = { id: request.id, ok: true };
				break;
			case 'execute':
				response = {
					id: request.id,
					ok: true,
					value: await withExecutionBridge(request.executionNonce, () =>
						engine.execute(request.program),
					),
				};
				break;
			case 'execute-query':
				response = {
					id: request.id,
					ok: true,
					value: await withExecutionBridge(request.executionNonce, () =>
						engine.executeQuery(request.request),
					),
				};
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
			...(error instanceof DataQueryUserError ? { kind: 'user-sql' as const } : {}),
		};
	}
	port.postMessage(response);
}

async function withExecutionBridge<T>(
	executionNonce: string | undefined,
	work: () => T | Promise<T>,
): Promise<T> {
	const previous = globalThis.XMLHttpRequest;
	Object.defineProperty(globalThis, 'XMLHttpRequest', {
		configurable: true,
		value: createSyncXmlHttpRequest({ port, executionNonce }),
	});
	try {
		return await work();
	} finally {
		Object.defineProperty(globalThis, 'XMLHttpRequest', {
			configurable: true,
			value: previous,
		});
	}
}
