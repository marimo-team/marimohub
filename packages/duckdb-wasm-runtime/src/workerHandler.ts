import { parentPort } from 'node:worker_threads';
import { DataQueryUserError } from '@marimo-hub/core/data-query-contracts';
import { BlockingDuckDBEngine } from './engine.ts';
import { isRuntimeRequest, runtimeRequestId } from './protocol.ts';
import type { RuntimeRequest, RuntimeResponse } from './protocol.ts';
import { createSyncXmlHttpRequest } from './syncXmlHttpRequest.ts';

if (!parentPort) throw new Error('DuckDB-Wasm worker started without a parent port.');
const port = parentPort;

Object.defineProperty(globalThis, 'XMLHttpRequest', {
	configurable: true,
	value: createSyncXmlHttpRequest({ port }),
});

const engine = new BlockingDuckDBEngine();
let requestQueue = Promise.resolve();

port.on('message', (request: unknown) => {
	requestQueue = requestQueue
		.then(
			() => handleMessage(request),
			() => handleMessage(request),
		)
		.catch(() => {});
});

async function handleMessage(value: unknown): Promise<void> {
	if (isRuntimeRequest(value)) {
		await handle(value);
		return;
	}
	const id = runtimeRequestId(value);
	if (id !== undefined) {
		port.postMessage({ id, ok: false, error: 'DuckDB-Wasm worker request is invalid.' });
	}
}

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
			default:
				return assertNever(request);
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

function assertNever(value: never): never {
	throw new Error(`Unhandled DuckDB-Wasm request: ${String(value)}`);
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
