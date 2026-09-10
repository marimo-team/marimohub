import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inClusterKubernetesApi } from './kernelIngress';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));

afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllEnvs();
});

function transport() {
	vi.stubEnv('KUBERNETES_SERVICE_HOST', 'kubernetes.default.svc');
	vi.stubEnv('KUBERNETES_SERVICE_PORT', '443');
	vi.mocked(readFile).mockResolvedValue('credential');
	const response = new EventEmitter();
	const outgoing = Object.assign(new EventEmitter(), {
		write: vi.fn(),
		end: vi.fn(),
		destroy: vi.fn(),
	});
	vi.mocked(request).mockImplementation((...args) => {
		const callback = args.at(-1) as (response: IncomingMessage) => void;
		callback(response as IncomingMessage);
		return outgoing as unknown as ReturnType<typeof request>;
	});
	return { api: inClusterKubernetesApi(), response, outgoing };
}

describe('inClusterKubernetesApi', () => {
	it('rejects when the API connection fails after response headers', async () => {
		const { api, response, outgoing } = transport();
		const pending = api.request('GET', '/api/v1/namespaces/test/services');
		const rejected = expect(pending).rejects.toThrow('connection reset');
		await vi.waitFor(() => expect(outgoing.end).toHaveBeenCalled());
		response.emit('data', Buffer.from('{"items":'));
		response.emit('error', new Error('connection reset'));
		await rejected;
	});

	it('rereads the projected token while retaining the cluster CA', async () => {
		const { api, response, outgoing } = transport();
		vi.mocked(readFile).mockResolvedValueOnce('cluster-ca').mockResolvedValueOnce('first-token');
		const first = api.request('GET', '/first');
		await vi.waitFor(() => expect(outgoing.end).toHaveBeenCalledTimes(1));
		response.emit('end');
		await first;
		vi.mocked(readFile).mockResolvedValueOnce('rotated-token');
		const second = api.request('GET', '/second');
		await vi.waitFor(() => expect(outgoing.end).toHaveBeenCalledTimes(2));
		response.emit('end');
		await second;
		expect(request).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				ca: 'cluster-ca',
				headers: expect.objectContaining({ authorization: 'Bearer rotated-token' }),
			}),
			expect.any(Function),
		);
		expect(readFile).toHaveBeenCalledTimes(3);
	});
});
