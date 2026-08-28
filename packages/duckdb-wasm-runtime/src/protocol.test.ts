import { describe, expect, it } from 'vitest';
import { isRuntimeRequest, runtimeRequestId } from './protocol';

describe('worker request protocol', () => {
	it.each([
		{ id: 1, type: 'ping' },
		{ id: 2, type: 'initialize', memoryLimitMb: 64, httpEnabled: true },
		{ id: 3, type: 'execute', program: { setup: [], query: { text: 'SELECT 1' } } },
		{ id: 4, type: 'execute-query', request: { sql: 'SELECT 1' } },
	])('accepts $type requests', (request) => {
		expect(isRuntimeRequest(request)).toBe(true);
	});

	it.each([
		null,
		{},
		{ id: 0, type: 'ping' },
		{ id: 1, type: 'unknown' },
		{ id: 1, type: 'initialize', memoryLimitMb: '64', httpEnabled: true },
		{ id: 1, type: 'execute', program: null },
		{ id: 1, type: 'execute-query', request: null },
		{ id: 1, type: 'execute', program: {}, executionNonce: 42 },
	])('rejects malformed request %#', (request) => {
		expect(isRuntimeRequest(request)).toBe(false);
	});

	it('retains a valid correlation id from a malformed request', () => {
		expect(runtimeRequestId({ id: 7, type: 'unknown' })).toBe(7);
		expect(runtimeRequestId({ id: -1, type: 'ping' })).toBeUndefined();
	});
});
