/**
 * Publishes each kernel at its public hostname with a Kubernetes Ingress.
 *
 * A CUSTOM-visibility service gets a ClusterIP Service in the sandbox
 * namespace and nothing else. The hub runs in the same cluster, so it creates
 * the Ingress itself, owner-referenced to the runner's Service so Kubernetes
 * garbage-collects it with the sandbox.
 */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';

export interface KernelIngressTarget {
	sandboxId: string;
	/** Public hostname the browser will use (host of the exposed URL). */
	host: string;
	port: number;
}

export interface KernelIngressPublisher {
	/** Idempotent: an Ingress that already exists is left alone. */
	publish(target: KernelIngressTarget): Promise<void>;
	/** Best-effort; the owner reference already covers the normal teardown. */
	remove(sandboxId: string): Promise<void>;
}

export interface KubernetesApi {
	request(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: unknown,
	): Promise<{ status: number; body: string }>;
}

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
/** Socket-inactivity cap so a hung API server cannot stall expose/teardown. */
const REQUEST_TIMEOUT_MS = 10_000;

/** In-cluster client: the pod's ServiceAccount token against the API server. */
export function inClusterKubernetesApi(): KubernetesApi {
	let cached: Promise<{ ca: string; host: string; port: string }> | undefined;
	const load = () => {
		cached ??= (async () => {
			const host = process.env.KUBERNETES_SERVICE_HOST;
			const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
			if (!host) throw new Error('KUBERNETES_SERVICE_HOST is unset: not running in-cluster');
			return { ca: await readFile(`${SA_DIR}/ca.crt`, 'utf8'), host, port };
		})();
		return cached;
	};
	return {
		async request(method, path, body) {
			// The CA and API-server address are stable for the pod's lifetime, but
			// kubelet ROTATES the projected token — reread it per request or a
			// long-running hub starts getting 401s.
			const [{ ca, host, port }, token] = await Promise.all([
				load(),
				readFile(`${SA_DIR}/token`, 'utf8').then((raw) => raw.trim()),
			]);
			const payload = body === undefined ? undefined : JSON.stringify(body);
			return new Promise((resolve, reject) => {
				const req = httpsRequest(
					{
						method,
						host,
						port,
						path,
						ca,
						timeout: REQUEST_TIMEOUT_MS,
						headers: {
							authorization: `Bearer ${token}`,
							accept: 'application/json',
							...(payload
								? {
										'content-type': 'application/json',
										'content-length': Buffer.byteLength(payload),
									}
								: {}),
						},
					},
					(res) => {
						const chunks: Buffer[] = [];
						res.on('data', (c: Buffer) => chunks.push(c));
						res.on('end', () =>
							resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
						);
					},
				);
				req.on('error', reject);
				req.on('timeout', () =>
					req.destroy(new Error(`Kubernetes API request timed out after ${REQUEST_TIMEOUT_MS}ms`)),
				);
				if (payload) req.write(payload);
				req.end();
			});
		},
	};
}

export interface KernelIngressOptions {
	/** Namespace the runner creates sandbox pods and Services in. */
	namespace: string;
	ingressClassName: string;
	api?: KubernetesApi;
	/** Service lookup retries: the runner creates it moments after `running`. */
	retries?: number;
	retryDelayMs?: number;
}

const SANDBOX_ID_LABEL = 'sandbox.coreweave.com/sandbox-id';

/**
 * The id is provider-generated and DNS-safe in practice, but it flows into
 * API paths and the Ingress name — refuse anything else defensively.
 */
function assertSandboxId(sandboxId: string): void {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(sandboxId)) {
		throw new Error(`unexpected sandbox id shape: ${JSON.stringify(sandboxId)}`);
	}
}

export function createKernelIngressPublisher(
	options: KernelIngressOptions,
): KernelIngressPublisher {
	const api = options.api ?? inClusterKubernetesApi();
	const ns = options.namespace;
	const retries = options.retries ?? 10;
	const retryDelayMs = options.retryDelayMs ?? 1000;
	const ingressName = (sandboxId: string) => `kernel-${sandboxId}`;

	async function findService(sandboxId: string): Promise<{ name: string; uid: string }> {
		const selector = encodeURIComponent(`${SANDBOX_ID_LABEL}=${sandboxId}`);
		for (let attempt = 0; ; attempt++) {
			const res = await api.request(
				'GET',
				`/api/v1/namespaces/${ns}/services?labelSelector=${selector}`,
			);
			if (res.status !== 200) {
				throw new Error(`listing sandbox Services failed (HTTP ${res.status}): ${res.body}`);
			}
			const list = JSON.parse(res.body) as {
				items: { metadata: { name: string; uid: string } }[];
			};
			if (list.items.length > 1) {
				throw new Error(
					`expected one Service for sandbox ${sandboxId} in ${ns}, found ${list.items.length}`,
				);
			}
			const svc = list.items[0];
			if (svc) return { name: svc.metadata.name, uid: svc.metadata.uid };
			if (attempt >= retries) {
				throw new Error(`no Service for sandbox ${sandboxId} in ${ns} after ${retries} retries`);
			}
			await sleep(retryDelayMs);
		}
	}

	return {
		async publish({ sandboxId, host, port }) {
			assertSandboxId(sandboxId);
			const svc = await findService(sandboxId);
			const res = await api.request(
				'POST',
				`/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`,
				{
					apiVersion: 'networking.k8s.io/v1',
					kind: 'Ingress',
					metadata: {
						name: ingressName(sandboxId),
						namespace: ns,
						labels: { 'app.kubernetes.io/managed-by': 'marimohub', [SANDBOX_ID_LABEL]: sandboxId },
						ownerReferences: [{ apiVersion: 'v1', kind: 'Service', name: svc.name, uid: svc.uid }],
					},
					spec: {
						ingressClassName: options.ingressClassName,
						rules: [
							{
								host,
								http: {
									paths: [
										{
											path: '/',
											pathType: 'Prefix',
											backend: { service: { name: svc.name, port: { number: port } } },
										},
									],
								},
							},
						],
					},
				},
			);
			// Resume/retry: assumes the existing Ingress still matches (the hostname
			// template and ingress class are deploy-stable within a sandbox's short
			// lifetime; a redeploy-spanning change is out of scope).
			if (res.status === 409) return;
			if (res.status < 200 || res.status >= 300) {
				throw new Error(`creating kernel Ingress failed (HTTP ${res.status}): ${res.body}`);
			}
		},
		async remove(sandboxId) {
			assertSandboxId(sandboxId);
			const res = await api.request(
				'DELETE',
				`/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/${ingressName(sandboxId)}`,
			);
			if (res.status === 404) return;
			if (res.status < 200 || res.status >= 300) {
				throw new Error(`deleting kernel Ingress failed (HTTP ${res.status}): ${res.body}`);
			}
		},
	};
}
