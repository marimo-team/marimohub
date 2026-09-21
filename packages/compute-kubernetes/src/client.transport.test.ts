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

	async function cluster(podStatus = 201) {
		const requests: { path: string; body: unknown }[] = [];
		server = createServer((request, response) => {
			let body = '';
			request.setEncoding('utf8');
			request.on('data', (chunk: string) => {
				body += chunk;
			});
			request.on('end', () => {
				const parsedBody: unknown = JSON.parse(body);
				requests.push({ path: request.url!, body: parsedBody });
				const status = request.url!.endsWith('/pods') ? podStatus : 201;
				response.writeHead(status, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify(
						status === 201
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
		expect(requests).toHaveLength(2);
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

	it('treats an existing Pod as a reconnect without replacing its template', async () => {
		const { client, requests } = await cluster(409);
		await expect(
			client.ensure({ ...options, podTemplate: { spec: { serviceAccountName: 'new-account' } } }),
		).resolves.toEqual({ createdPod: false });
		expect(requests.map((r) => r.path).sort()).toEqual([
			'/api/v1/namespaces/kernels/pods',
			'/api/v1/namespaces/kernels/services',
		]);
	});

	it('makes no HTTP requests when template validation fails', async () => {
		const { client, requests } = await cluster();
		await expect(
			client.ensure({
				...options,
				podTemplate: { metadata: { labels: { 'marimohub.io/sandbox-name': 'other' } } },
			}),
		).rejects.toThrow(/selector labels/);
		expect(requests).toEqual([]);
		expect(KubeConfig.prototype.loadFromCluster).not.toHaveBeenCalled();
	});
});
