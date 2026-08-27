import { describe, expect, it } from 'vitest';
import { createKernelIngressPublisher } from './kernelIngress';
import type { KubernetesApi } from './kernelIngress';

interface Call {
	method: string;
	path: string;
	body?: unknown;
}

function fakeApi(handlers: {
	services?: () => { items: { metadata: { name: string; uid: string } }[] };
	ingressStatus?: number;
	deleteStatus?: number;
}) {
	const calls: Call[] = [];
	const api: KubernetesApi = {
		async request(method, path, body) {
			calls.push({ method, path, body });
			if (method === 'GET' && path.includes('/services')) {
				return { status: 200, body: JSON.stringify(handlers.services?.() ?? { items: [] }) };
			}
			if (method === 'POST') return { status: handlers.ingressStatus ?? 201, body: '{}' };
			if (method === 'DELETE') return { status: handlers.deleteStatus ?? 200, body: '{}' };
			return { status: 500, body: 'unexpected' };
		},
	};
	return { api, calls };
}

const target = { sandboxId: 'abc-123', host: 'abc-123.sandbox.example.com', port: 2718 };

describe('createKernelIngressPublisher', () => {
	it('creates an Ingress for the runner Service, owner-referenced to it', async () => {
		const { api, calls } = fakeApi({
			services: () => ({ items: [{ metadata: { name: 'sabc-123-service', uid: 'uid-1' } }] }),
		});
		const publisher = createKernelIngressPublisher({
			namespace: 'org-ns',
			ingressClassName: 'traefik',
			api,
		});
		await publisher.publish(target);
		const post = calls.find((c) => c.method === 'POST');
		expect(post?.path).toBe('/apis/networking.k8s.io/v1/namespaces/org-ns/ingresses');
		expect(post?.body).toMatchObject({
			metadata: {
				name: 'kernel-abc-123',
				ownerReferences: [{ kind: 'Service', name: 'sabc-123-service', uid: 'uid-1' }],
			},
			spec: {
				ingressClassName: 'traefik',
				rules: [
					{
						host: 'abc-123.sandbox.example.com',
						http: {
							paths: [
								{ backend: { service: { name: 'sabc-123-service', port: { number: 2718 } } } },
							],
						},
					},
				],
			},
		});
	});

	it('waits for the Service the runner creates after the sandbox is running', async () => {
		let polls = 0;
		const { api, calls } = fakeApi({
			services: () => {
				polls++;
				return polls < 3 ? { items: [] } : { items: [{ metadata: { name: 'svc', uid: 'u' } }] };
			},
		});
		const publisher = createKernelIngressPublisher({
			namespace: 'org-ns',
			ingressClassName: 'traefik',
			api,
			retries: 5,
			retryDelayMs: 1,
		});
		await publisher.publish(target);
		expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3);
		expect(calls.some((c) => c.method === 'POST')).toBe(true);
	});

	it('fails when the Service never appears', async () => {
		const { api } = fakeApi({});
		const publisher = createKernelIngressPublisher({
			namespace: 'org-ns',
			ingressClassName: 'traefik',
			api,
			retries: 1,
			retryDelayMs: 1,
		});
		await expect(publisher.publish(target)).rejects.toThrow(/no Service for sandbox/);
	});

	it('treats an existing Ingress as published and a missing one as removed', async () => {
		const { api } = fakeApi({
			services: () => ({ items: [{ metadata: { name: 'svc', uid: 'u' } }] }),
			ingressStatus: 409,
			deleteStatus: 404,
		});
		const publisher = createKernelIngressPublisher({
			namespace: 'org-ns',
			ingressClassName: 'traefik',
			api,
		});
		await expect(publisher.publish(target)).resolves.toBeUndefined();
		await expect(publisher.remove('abc-123')).resolves.toBeUndefined();
	});
});
