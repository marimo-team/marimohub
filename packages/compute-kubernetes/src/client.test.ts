import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxId } from '@marimo-hub/core';

const k8sMock = vi.hoisted(() => {
	class CoreV1Api {}
	class NetworkingV1Api {}

	const core = {
		createNamespacedPod: vi.fn(),
		createNamespacedService: vi.fn(),
		readNamespacedPod: vi.fn(),
		listNamespacedEvent: vi.fn(),
		deleteNamespacedService: vi.fn(),
		deleteNamespacedPod: vi.fn(),
		listNamespacedPod: vi.fn(),
	};
	const net = {
		createNamespacedIngress: vi.fn(),
		readNamespacedIngress: vi.fn(),
		replaceNamespacedIngress: vi.fn(),
		deleteNamespacedIngress: vi.fn(),
	};
	const exec = vi.fn();
	const kubeConfigs: unknown[] = [];

	class KubeConfig {
		loadFromCluster = vi.fn(() => {
			throw new Error('not in cluster');
		});
		loadFromDefault = vi.fn();
		makeApiClient = vi.fn((api: unknown) => {
			if (api === CoreV1Api) return core;
			if (api === NetworkingV1Api) return net;
			throw new Error('unexpected api client');
		});

		constructor() {
			kubeConfigs.push(this);
		}
	}

	class Exec {
		exec = exec;
	}

	return { CoreV1Api, NetworkingV1Api, KubeConfig, Exec, core, net, exec, kubeConfigs };
});

vi.mock('@kubernetes/client-node', () => ({
	CoreV1Api: k8sMock.CoreV1Api,
	NetworkingV1Api: k8sMock.NetworkingV1Api,
	KubeConfig: k8sMock.KubeConfig,
	Exec: k8sMock.Exec,
}));

import { createK8sClient } from './client';
import {
	defaultImagePullPolicy,
	MANAGED_BY_LABEL,
	MANAGED_BY_VALUE,
	SANDBOX_ID_ANNOTATION,
} from './shared';

const SANDBOX_ID = 'sb-aaaaaaaaaaaaaaaa' as SandboxId;

beforeEach(() => {
	for (const fn of [
		k8sMock.core.createNamespacedPod,
		k8sMock.core.createNamespacedService,
		k8sMock.core.readNamespacedPod,
		k8sMock.core.listNamespacedEvent,
		k8sMock.core.deleteNamespacedService,
		k8sMock.core.deleteNamespacedPod,
		k8sMock.core.listNamespacedPod,
		k8sMock.net.createNamespacedIngress,
		k8sMock.net.readNamespacedIngress,
		k8sMock.net.replaceNamespacedIngress,
		k8sMock.net.deleteNamespacedIngress,
		k8sMock.exec,
	]) {
		fn.mockReset().mockResolvedValue({});
	}
	k8sMock.kubeConfigs.length = 0;
});

describe('createK8sClient', () => {
	it('creates pod, service, and ingress manifests and tolerates already-exists responses', async () => {
		k8sMock.core.createNamespacedPod.mockRejectedValueOnce({ code: 409 });
		const client = createK8sClient({ namespace: 'kernels' });

		// A 409 on the Pod means we reconnected to an existing sandbox.
		await expect(
			client.ensure({
				name: 'mh-sb',
				sandboxId: SANDBOX_ID,
				host: 'sb.example.com',
				image: 'kernel-image:v1',
				port: 2718,
				namespace: 'kernels',
				ingressClassName: 'nginx',
				ingressAnnotations: {
					'route.openshift.io/termination': 'edge',
				},
				tlsSecretName: 'wildcard-cert',
				serviceAccountName: 'kernel-sa',
				imagePullSecret: 'regcred',
				resources: { cpu: '2', memory: '4Gi', gpu: '1' },
			}),
		).resolves.toEqual({ createdPod: false });

		expect(k8sMock.kubeConfigs).toHaveLength(1);
		const pod = k8sMock.core.createNamespacedPod.mock.calls[0]?.[0].body;
		expect(pod).toMatchObject({
			metadata: {
				name: 'mh-sb',
				namespace: 'kernels',
				labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
				annotations: { [SANDBOX_ID_ANNOTATION]: SANDBOX_ID },
			},
			spec: {
				// Short grace: the keep-alive `sleep` ignores SIGTERM, and 30s of
				// Terminating per deleted Pod holds resources for nothing.
				terminationGracePeriodSeconds: 5,
				serviceAccountName: 'kernel-sa',
				imagePullSecrets: [{ name: 'regcred' }],
				containers: [
					{
						name: 'marimo',
						image: 'kernel-image:v1',
						// Pinned tag → cached nodes skip the registry round-trip.
						imagePullPolicy: 'IfNotPresent',
						ports: [{ containerPort: 2718 }],
						resources: {
							requests: { cpu: '2', memory: '4Gi' },
							limits: { 'nvidia.com/gpu': '1' },
						},
					},
				],
			},
		});
		expect(k8sMock.core.createNamespacedService.mock.calls[0]?.[0].body).toMatchObject({
			spec: { selector: { 'marimohub.io/sandbox-name': 'mh-sb' } },
		});
		expect(k8sMock.net.createNamespacedIngress.mock.calls[0]?.[0].body).toMatchObject({
			metadata: {
				annotations: { 'route.openshift.io/termination': 'edge' },
			},
			spec: {
				ingressClassName: 'nginx',
				tls: [{ hosts: ['sb.example.com'], secretName: 'wildcard-cert' }],
				rules: [{ host: 'sb.example.com' }],
			},
		});
		expect(k8sMock.net.readNamespacedIngress).not.toHaveBeenCalled();
		expect(k8sMock.net.replaceNamespacedIngress).not.toHaveBeenCalled();
	});

	it('emits an empty TLS entry for the ingress-controller default certificate', async () => {
		const client = createK8sClient({ namespace: 'kernels' });
		await client.ensure({
			name: 'mh-sb',
			sandboxId: SANDBOX_ID,
			host: 'sb.example.com',
			image: 'kernel-image:v1',
			port: 2718,
			namespace: 'kernels',
			ingressTlsMode: 'default',
		});

		const ingress = k8sMock.net.createNamespacedIngress.mock.calls[0]?.[0].body;
		expect(ingress.spec.tls).toEqual([{}]);
	});

	it('reconciles an existing managed ingress with current annotations and TLS', async () => {
		k8sMock.net.createNamespacedIngress.mockRejectedValueOnce({ code: 409 });
		k8sMock.net.readNamespacedIngress.mockResolvedValueOnce({
			metadata: {
				name: 'mh-sb',
				resourceVersion: '7',
				labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, 'controller.example/label': 'keep' },
				annotations: { 'old.example/setting': 'stale' },
				finalizers: ['controller.example/finalizer'],
				ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: 'owner', uid: 'uid' }],
			},
		});
		const client = createK8sClient({ namespace: 'kernels' });

		await client.ensure({
			name: 'mh-sb',
			sandboxId: SANDBOX_ID,
			host: 'sb.example.com',
			image: 'kernel-image:v1',
			port: 2718,
			namespace: 'kernels',
			ingressAnnotations: { 'route.openshift.io/termination': 'edge' },
			ingressTlsMode: 'default',
		});

		expect(k8sMock.net.readNamespacedIngress).toHaveBeenCalledWith({
			name: 'mh-sb',
			namespace: 'kernels',
		});
		expect(k8sMock.net.replaceNamespacedIngress).toHaveBeenCalledWith({
			name: 'mh-sb',
			namespace: 'kernels',
			body: expect.objectContaining({
				metadata: expect.objectContaining({
					resourceVersion: '7',
					labels: {
						[MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
						'controller.example/label': 'keep',
					},
					annotations: { 'route.openshift.io/termination': 'edge' },
					finalizers: ['controller.example/finalizer'],
				}),
				spec: expect.objectContaining({ tls: [{}] }),
			}),
		});
	});

	it('removes TLS when reconciling an ingress in disabled mode', async () => {
		k8sMock.net.createNamespacedIngress.mockRejectedValueOnce({ code: 409 });
		k8sMock.net.readNamespacedIngress.mockResolvedValueOnce({
			metadata: {
				resourceVersion: '8',
				labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
			},
		});
		const client = createK8sClient({ namespace: 'kernels' });

		await client.ensure({
			name: 'mh-sb',
			sandboxId: SANDBOX_ID,
			host: 'sb.example.com',
			image: 'kernel-image:v1',
			port: 2718,
			namespace: 'kernels',
			ingressTlsMode: 'disabled',
		});

		const replacement = k8sMock.net.replaceNamespacedIngress.mock.calls[0]?.[0].body;
		expect(replacement.spec.tls).toBeUndefined();
	});

	it.each([
		['uppercase DNS prefix', 'Example.com/name'],
		['name longer than 63 characters', `example.com/${'a'.repeat(64)}`],
		['prefix longer than 253 characters', `${'a'.repeat(254)}/name`],
		['multiple separators', 'example.com/part/name'],
	])('rejects an invalid ingress annotation key: %s', async (_label, key) => {
		const client = createK8sClient({ namespace: 'kernels' });
		await expect(
			client.ensure({
				name: 'mh-sb',
				sandboxId: SANDBOX_ID,
				host: 'sb.example.com',
				image: 'kernel-image:v1',
				port: 2718,
				namespace: 'kernels',
				ingressAnnotations: { [key]: 'value' },
			}),
		).rejects.toThrow(/invalid .*annotation/i);
		expect(k8sMock.core.createNamespacedPod).not.toHaveBeenCalled();
		expect(k8sMock.core.createNamespacedService).not.toHaveBeenCalled();
		expect(k8sMock.net.createNamespacedIngress).not.toHaveBeenCalled();
	});

	it('rejects ingress annotations larger than 256 KiB before making API calls', async () => {
		const client = createK8sClient({ namespace: 'kernels' });
		await expect(
			client.ensure({
				name: 'mh-sb',
				sandboxId: SANDBOX_ID,
				host: 'sb.example.com',
				image: 'kernel-image:v1',
				port: 2718,
				namespace: 'kernels',
				ingressAnnotations: { name: 'x'.repeat(256 * 1024) },
			}),
		).rejects.toThrow(/256 KiB/);
		expect(k8sMock.core.createNamespacedPod).not.toHaveBeenCalled();
	});

	it('omits TLS when ingress TLS is disabled', async () => {
		const client = createK8sClient({ namespace: 'kernels' });
		await client.ensure({
			name: 'mh-sb',
			sandboxId: SANDBOX_ID,
			host: 'sb.example.com',
			image: 'kernel-image:v1',
			port: 2718,
			namespace: 'kernels',
			ingressTlsMode: 'disabled',
		});

		const ingress = k8sMock.net.createNamespacedIngress.mock.calls[0]?.[0].body;
		expect(ingress.spec.tls).toBeUndefined();
	});

	it('rejects secret TLS mode without a secret name', async () => {
		const client = createK8sClient({ namespace: 'kernels' });
		await expect(
			client.ensure({
				name: 'mh-sb',
				sandboxId: SANDBOX_ID,
				host: 'sb.example.com',
				image: 'kernel-image:v1',
				port: 2718,
				namespace: 'kernels',
				ingressTlsMode: 'secret',
			}),
		).rejects.toThrow(/requires a TLS secret name/);
		expect(k8sMock.core.createNamespacedPod).not.toHaveBeenCalled();
		expect(k8sMock.core.createNamespacedService).not.toHaveBeenCalled();
	});

	it('skips ingress creation when no host is configured', async () => {
		const client = createK8sClient({});

		await expect(
			client.ensure({
				name: 'mh-sb',
				sandboxId: SANDBOX_ID,
				host: '',
				image: 'kernel-image',
				port: 2718,
				namespace: 'default',
			}),
		).resolves.toEqual({ createdPod: true });

		expect(k8sMock.net.createNamespacedIngress).not.toHaveBeenCalled();
	});

	it('honours an explicit imagePullPolicy override', async () => {
		const client = createK8sClient({});
		await client.ensure({
			name: 'mh-sb',
			sandboxId: SANDBOX_ID,
			host: '',
			image: 'kernel-image:v1',
			port: 2718,
			namespace: 'default',
			imagePullPolicy: 'Always',
		});

		const pod = k8sMock.core.createNamespacedPod.mock.calls[0]?.[0].body;
		expect(pod.spec.containers[0].imagePullPolicy).toBe('Always');
	});

	it('defaults the pull policy per tag mutability, like Kubernetes itself', async () => {
		// Mutable :latest must keep refreshing — a cached stale image would
		// otherwise be served forever under IfNotPresent.
		const client = createK8sClient({});
		await client.ensure({
			name: 'mh-sb',
			sandboxId: SANDBOX_ID,
			host: '',
			image: 'ghcr.io/marimo-team/marimo:latest',
			port: 2718,
			namespace: 'default',
		});
		const pod = k8sMock.core.createNamespacedPod.mock.calls[0]?.[0].body;
		expect(pod.spec.containers[0].imagePullPolicy).toBe('Always');

		expect(defaultImagePullPolicy('img')).toBe('Always');
		expect(defaultImagePullPolicy('img:latest')).toBe('Always');
		expect(defaultImagePullPolicy('img:v1')).toBe('IfNotPresent');
		expect(defaultImagePullPolicy('img@sha256:abc')).toBe('IfNotPresent');
		// A registry port is not a tag.
		expect(defaultImagePullPolicy('registry:5000/img')).toBe('Always');
		expect(defaultImagePullPolicy('registry:5000/img:v1')).toBe('IfNotPresent');
	});

	it('adds limits only for fields supplied by a compute profile', async () => {
		const client = createK8sClient({});
		await client.ensure({
			name: 'mh-sb',
			sandboxId: SANDBOX_ID,
			host: '',
			image: 'kernel-image',
			port: 2718,
			namespace: 'default',
			resources: {
				cpu: '2',
				memory: '1024Mi',
				profileLimits: { memory: true },
			},
		});

		const pod = k8sMock.core.createNamespacedPod.mock.calls[0]?.[0].body;
		expect(pod.spec.containers[0].resources).toEqual({
			requests: { cpu: '2', memory: '1024Mi' },
			limits: { memory: '1024Mi' },
		});
	});

	it('returns undefined for a missing pod phase and rethrows other read errors', async () => {
		const client = createK8sClient({ namespace: 'kernels' });
		k8sMock.core.readNamespacedPod.mockRejectedValueOnce({ code: 404 });
		k8sMock.core.readNamespacedPod.mockRejectedValueOnce(new Error('api down'));

		await expect(client.getPhase('missing')).resolves.toBeUndefined();
		await expect(client.getPhase('broken')).rejects.toThrow('api down');
		expect(k8sMock.core.readNamespacedPod).toHaveBeenCalledWith({
			name: 'missing',
			namespace: 'kernels',
		});
	});

	it('returns the latest FailedScheduling event message', async () => {
		k8sMock.core.listNamespacedEvent.mockResolvedValueOnce({
			items: [
				{ reason: 'Pulled', message: 'image pulled' },
				{
					reason: 'FailedScheduling',
					message: 'stale scheduling failure',
					lastTimestamp: new Date('2026-01-01T00:00:00.000Z'),
					metadata: {},
				},
				{
					reason: 'FailedScheduling',
					message: '0/3 nodes are available: 3 Insufficient memory.',
					lastTimestamp: new Date('2026-01-01T00:02:00.000Z'),
					metadata: {},
				},
				{
					reason: 'FailedScheduling',
					message: 'older failure returned last',
					lastTimestamp: new Date('2026-01-01T00:01:00.000Z'),
					metadata: {},
				},
			],
		});
		const client = createK8sClient({ namespace: 'kernels' });

		await expect(client.getSchedulingFailure('mh-sb')).resolves.toBe(
			'0/3 nodes are available: 3 Insufficient memory.',
		);
		expect(k8sMock.core.listNamespacedEvent).toHaveBeenCalledWith({
			namespace: 'kernels',
			fieldSelector: 'involvedObject.kind=Pod,involvedObject.name=mh-sb',
		});
	});

	it('getPhase carries the boot timestamps from True conditions on the same read', async () => {
		k8sMock.core.readNamespacedPod.mockResolvedValueOnce({
			metadata: { uid: 'uid-current', creationTimestamp: new Date('2026-01-01T00:00:00.000Z') },
			status: {
				phase: 'Running',
				conditions: [
					{
						type: 'PodScheduled',
						status: 'True',
						lastTransitionTime: new Date('2026-01-01T00:00:00.100Z'),
					},
					// A transient not-Ready condition must not be reported as readiness.
					{
						type: 'Ready',
						status: 'False',
						lastTransitionTime: new Date('2026-01-01T00:00:01.000Z'),
					},
					{
						type: 'Ready',
						status: 'True',
						lastTransitionTime: new Date('2026-01-01T00:00:02.500Z'),
					},
				],
			},
		});
		const client = createK8sClient({ namespace: 'kernels' });

		await expect(client.getPhase('mh-sb')).resolves.toEqual({
			phase: 'Running',
			uid: 'uid-current',
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			scheduledAt: new Date('2026-01-01T00:00:00.100Z'),
			readyAt: new Date('2026-01-01T00:00:02.500Z'),
		});
	});

	it('getImagePullMessage matches only the current Pod incarnation', async () => {
		k8sMock.core.listNamespacedEvent.mockResolvedValueOnce({
			items: [
				{ reason: 'Scheduled', message: 'assigned' },
				// Same Pod NAME from a previous session — a recreated Pod reuses the
				// deterministic name, so only the current UID's event counts.
				{
					reason: 'Pulled',
					message: 'stale pull from a previous pod',
					involvedObject: { uid: 'uid-old' },
				},
				{
					reason: 'Pulled',
					message: 'Successfully pulled image "img" in 2.096s (…)',
					involvedObject: { uid: 'uid-current' },
				},
			],
		});
		const client = createK8sClient({ namespace: 'kernels' });

		await expect(client.getImagePullMessage('mh-sb', 'uid-current')).resolves.toBe(
			'Successfully pulled image "img" in 2.096s (…)',
		);
	});

	it('getImagePullMessage is best-effort: an unreadable event list yields undefined', async () => {
		k8sMock.core.listNamespacedEvent.mockRejectedValueOnce(new Error('api down'));
		const client = createK8sClient({ namespace: 'kernels' });

		await expect(client.getImagePullMessage('mh-sb', 'uid-current')).resolves.toBeUndefined();
	});

	it('collects exec stdout/stderr and maps terminal status to an exit code', async () => {
		const client = createK8sClient({ namespace: 'kernels' });
		k8sMock.exec.mockImplementation(
			async (
				_namespace: string,
				_name: string,
				_container: string,
				_command: string[],
				stdout: Writable,
				stderr: Writable,
				stdin: Readable | null,
				_tty: boolean,
				statusCallback: (status: unknown) => void,
			) => {
				stdin?.resume();
				stdout.write('out');
				stderr.write('err');
				statusCallback({
					status: 'Failure',
					details: { causes: [{ reason: 'ExitCode', message: '7' }] },
				});
				const socket = new EventEmitter();
				setTimeout(() => socket.emit('close'), 0);
				return socket;
			},
		);

		await expect(client.exec('pod-1', ['sh', '-lc', 'cmd'], 'input')).resolves.toEqual({
			stdout: 'out',
			stderr: 'err',
			exitCode: 7,
		});
		expect(k8sMock.exec.mock.calls[0]?.slice(0, 4)).toEqual([
			'kernels',
			'pod-1',
			'marimo',
			['sh', '-lc', 'cmd'],
		]);
	});

	it('rethrows a 403 RBAC-forbidden pod create (only 409 is tolerated)', async () => {
		k8sMock.core.createNamespacedPod.mockRejectedValueOnce({ code: 403 });
		const client = createK8sClient({ namespace: 'kernels' });

		await expect(
			client.ensure({
				name: 'mh-sb',
				sandboxId: SANDBOX_ID,
				host: '',
				image: 'kernel-image',
				port: 2718,
				namespace: 'kernels',
			}),
		).rejects.toMatchObject({ code: 403 });
	});

	it('rethrows a non-404 delete error (e.g. 403)', async () => {
		k8sMock.net.deleteNamespacedIngress.mockRejectedValueOnce({ code: 403 });
		const client = createK8sClient({ namespace: 'kernels' });

		await expect(client.delete('mh-sb')).rejects.toMatchObject({ code: 403 });
	});

	it('streams a Uint8Array stdin as raw bytes to the pod (objectMode:false)', async () => {
		const client = createK8sClient({ namespace: 'kernels' });
		const received: Buffer[] = [];
		let objectMode: boolean | undefined;
		let everyChunkWasRawBytes = true;
		k8sMock.exec.mockImplementation(
			async (
				_namespace: string,
				_name: string,
				_container: string,
				_command: string[],
				_stdout: Writable,
				_stderr: Writable,
				stdin: Readable | null,
				_tty: boolean,
				statusCallback: (status: unknown) => void,
			) => {
				const socket = new EventEmitter();
				objectMode = stdin?.readableObjectMode;
				stdin?.on('data', (chunk) => {
					// In object mode the whole Uint8Array would arrive as one non-Buffer
					// object chunk; a byte stream delivers Buffer chunks.
					if (!Buffer.isBuffer(chunk)) everyChunkWasRawBytes = false;
					received.push(Buffer.from(chunk));
				});
				stdin?.on('end', () => {
					statusCallback({ status: 'Success' });
					setTimeout(() => socket.emit('close'), 0);
				});
				return socket;
			},
		);

		const bytes = new Uint8Array([0xff, 0x00, 0x80, 0x7f]);
		const res = await client.exec('pod-1', ['sh', '-lc', 'cat'], bytes);
		expect(objectMode).toBe(false);
		expect(everyChunkWasRawBytes).toBe(true);
		expect([...Buffer.concat(received)]).toEqual([0xff, 0x00, 0x80, 0x7f]);
		expect(res.exitCode).toBe(0);
	});

	it.each([
		['a missing ExitCode cause', { status: 'Failure' }],
		[
			'a non-numeric ExitCode cause',
			{ status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: 'boom' }] } },
		],
	])('defaults a Failure status with %s to exit code 1', async (_label, status) => {
		const client = createK8sClient({ namespace: 'kernels' });
		k8sMock.exec.mockImplementation(
			async (
				_namespace: string,
				_name: string,
				_container: string,
				_command: string[],
				_stdout: Writable,
				_stderr: Writable,
				stdin: Readable | null,
				_tty: boolean,
				statusCallback: (status: unknown) => void,
			) => {
				stdin?.resume();
				statusCallback(status);
				const socket = new EventEmitter();
				setTimeout(() => socket.emit('close'), 0);
				return socket;
			},
		);

		await expect(client.exec('pod-1', ['sh', '-lc', 'cmd'])).resolves.toMatchObject({
			exitCode: 1,
		});
	});

	it('deletes ingress, service, and pod while tolerating 404s', async () => {
		k8sMock.net.deleteNamespacedIngress.mockRejectedValueOnce({ code: 404 });
		const client = createK8sClient({ namespace: 'kernels' });

		await client.delete('mh-sb');

		expect(k8sMock.net.deleteNamespacedIngress).toHaveBeenCalledWith({
			name: 'mh-sb',
			namespace: 'kernels',
		});
		expect(k8sMock.core.deleteNamespacedService).toHaveBeenCalledWith({
			name: 'mh-sb',
			namespace: 'kernels',
		});
		expect(k8sMock.core.deleteNamespacedPod).toHaveBeenCalledWith({
			name: 'mh-sb',
			namespace: 'kernels',
		});
	});

	it('lists only pods with well-formed sandbox annotations', async () => {
		k8sMock.core.listNamespacedPod.mockResolvedValueOnce({
			items: [
				{
					metadata: {
						annotations: { [SANDBOX_ID_ANNOTATION]: SANDBOX_ID },
						creationTimestamp: new Date('2026-01-01T00:00:00.000Z'),
					},
					status: { phase: 'Running' },
				},
				{
					metadata: {
						annotations: { [SANDBOX_ID_ANNOTATION]: 'native-k8s-id' },
					},
					status: { phase: 'Running' },
				},
			],
		});
		const client = createK8sClient({ namespace: 'kernels' });

		await expect(client.list()).resolves.toEqual([
			{
				sandboxId: SANDBOX_ID,
				phase: 'Running',
				createdAt: '2026-01-01T00:00:00.000Z',
			},
		]);
		expect(k8sMock.core.listNamespacedPod).toHaveBeenCalledWith({
			namespace: 'kernels',
			labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
		});
	});
});
