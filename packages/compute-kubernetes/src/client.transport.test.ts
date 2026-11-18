import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KubeConfig } from '@kubernetes/client-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxId } from '@marimo-hub/core/ids';
import { createK8sClient } from './client';
import { parsePodTemplate, validatePodTemplate } from './podTemplate';
import { projectedToken } from './podTemplate.testUtils';
import type { EnsureSandboxOptions } from './shared';

const options: EnsureSandboxOptions = {
	name: 'mh-transport',
	namespace: 'kernels',
	sandboxId: 'sb-transport' as SandboxId,
	image: 'runtime:v1',
	ports: [{ port: 2718, host: '' }],
};

describe('pod templates over the Kubernetes SDK HTTP transport', () => {
	let server: Server | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server!.close((error) => (error ? reject(error) : resolve())),
			);
			server = undefined;
		}
	});

	async function cluster(podStatus = 201, podExists = false) {
		const requests: { method: string; path: string; body: unknown }[] = [];
		server = createServer((request, response) => {
			let body = '';
			request.setEncoding('utf8');
			request.on('data', (chunk: string) => {
				body += chunk;
			});
			request.on('end', () => {
				const parsedBody: unknown = body ? JSON.parse(body) : undefined;
				requests.push({ method: request.method!, path: request.url!, body: parsedBody });
				const readingPod =
					request.method === 'GET' &&
					request.url === `/api/v1/namespaces/kernels/pods/${options.name}`;
				const status = readingPod
					? podExists
						? 200
						: 404
					: request.url!.endsWith('/pods')
						? podStatus
						: 201;
				response.writeHead(status, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify(
						status === 200
							? { apiVersion: 'v1', kind: 'Pod', metadata: { name: options.name } }
							: status === 201
								? parsedBody
								: {
										apiVersion: 'v1',
										kind: 'Status',
										status: 'Failure',
										code: status,
										message: 'Pod rejected by test API',
										reason: status === 409 ? 'AlreadyExists' : 'Invalid',
									},
					),
				);
			});
		});
		await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
		const address = server.address() as AddressInfo;
		vi.spyOn(KubeConfig.prototype, 'loadFromCluster').mockImplementation(
			function (this: KubeConfig) {
				this.loadFromOptions({
					clusters: [
						{ name: 'test', server: `http://127.0.0.1:${address.port}`, skipTLSVerify: true },
					],
					users: [{ name: 'test' }],
					contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
					currentContext: 'test',
				});
			},
		);
		vi.spyOn(KubeConfig.prototype, 'loadFromDefault').mockImplementation(() => {
			throw new Error('Tests must not read local kubeconfig');
		});
		return { client: createK8sClient({ namespace: 'kernels' }), requests };
	}

	it('preserves projected tokens, false security settings, and octal modes on the wire', async () => {
		const { client, requests } = await cluster();
		const podTemplate = parsePodTemplate(projectedToken);
		await expect(client.ensure({ ...options, podTemplate })).resolves.toEqual({ createdPod: true });
		expect(requests).toHaveLength(3);
		expect(requests.find((r) => r.path.endsWith('/pods'))?.body).toMatchObject(podTemplate);
		expect(requests.find((r) => r.path.endsWith('/services'))?.body).toMatchObject({
			spec: { selector: { 'marimohub.io/sandbox-name': options.name } },
		});
	});

	it('exposes the SDK dropping unfamiliar Pod and container fields after local validation', async () => {
		const { client, requests } = await cluster();
		const podTemplate = validatePodTemplate({
			spec: {
				futurePodOption: { enabled: true },
				containers: [{ name: 'marimo', futureContainerOption: { enabled: true } }],
			},
		});
		await client.ensure({ ...options, podTemplate });
		const body = requests.find((r) => r.path.endsWith('/pods'))?.body;
		expect(body).toMatchObject({ spec: { containers: [{ name: 'marimo', image: 'runtime:v1' }] } });
		// Characterize the SDK limitation until pod submission preserves raw JSON.
		expect(JSON.stringify(body)).not.toContain('futurePodOption');
		expect(JSON.stringify(body)).not.toContain('futureContainerOption');
		expect(JSON.stringify(podTemplate)).toContain('futurePodOption');
		expect(JSON.stringify(podTemplate)).toContain('futureContainerOption');
	});

	it.each([400, 403, 422, 429, 500, 503])(
		'propagates API rejection %i without treating the Pod as created',
		async (code) => {
			const { client } = await cluster(code);
			await expect(
				client.ensure({ ...options, podTemplate: { spec: { serviceAccountName: 'missing' } } }),
			).rejects.toMatchObject({ code });
		},
	);

	it('tolerates a competing Pod create without replacing its template', async () => {
		const { client, requests } = await cluster(409);
		await expect(
			client.ensure({ ...options, podTemplate: { spec: { serviceAccountName: 'new-account' } } }),
		).resolves.toEqual({ createdPod: false });
		expect(requests.map((r) => r.path).sort()).toEqual([
			'/api/v1/namespaces/kernels/pods',
			`/api/v1/namespaces/kernels/pods/${options.name}`,
			'/api/v1/namespaces/kernels/services',
		]);
	});

	it('reuses an existing Pod without sending a create request through the SDK', async () => {
		const { client, requests } = await cluster(403, true);
		for (let i = 0; i < 2; i++) {
			await expect(client.ensure(options)).resolves.toEqual({ createdPod: false });
		}
		expect(requests.filter((r) => r.path.endsWith('/pods'))).toEqual([]);
		expect(requests.filter((r) => r.method === 'GET')).toEqual([
			{
				method: 'GET',
				path: `/api/v1/namespaces/kernels/pods/${options.name}`,
				body: undefined,
			},
			{
				method: 'GET',
				path: `/api/v1/namespaces/kernels/pods/${options.name}`,
				body: undefined,
			},
		]);
		expect(requests.filter((r) => r.path.endsWith('/services'))).toHaveLength(2);
	});

	it('makes no HTTP requests when template validation fails', async () => {
		const { client, requests } = await cluster();
		await expect(
			client.ensure({
				...options,
				podTemplate: { metadata: { labels: { 'marimohub.io/sandbox-name': 'other' } } },
			}),
		).rejects.toThrow(/reserved management, selector, or notebook identity/);
		expect(requests).toEqual([]);
		expect(KubeConfig.prototype.loadFromCluster).not.toHaveBeenCalled();
	});
});
