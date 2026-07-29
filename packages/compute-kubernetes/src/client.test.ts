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
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, SANDBOX_ID_ANNOTATION } from './shared';

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

		await client.ensure({
			name: 'mh-sb',
			sandboxId: SANDBOX_ID,
			host: 'sb.example.com',
			image: 'kernel-image',
			port: 2718,
			namespace: 'kernels',
			ingressClassName: 'nginx',
			tlsSecretName: 'wildcard-cert',
			serviceAccountName: 'kernel-sa',
			imagePullSecret: 'regcred',
			resources: { cpu: '2', memory: '4Gi', gpu: '1' },
		});

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
				serviceAccountName: 'kernel-sa',
				imagePullSecrets: [{ name: 'regcred' }],
				containers: [
					{
						name: 'marimo',
						image: 'kernel-image',
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
			spec: {
				ingressClassName: 'nginx',
				tls: [{ hosts: ['sb.example.com'], secretName: 'wildcard-cert' }],
				rules: [{ host: 'sb.example.com' }],
			},
		});
	});

	it('skips ingress creation when no host is configured', async () => {
		const client = createK8sClient({});

		await client.ensure({
			name: 'mh-sb',
			sandboxId: SANDBOX_ID,
			host: '',
			image: 'kernel-image',
			port: 2718,
			namespace: 'default',
		});

		expect(k8sMock.net.createNamespacedIngress).not.toHaveBeenCalled();
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
		expect(Array.from(Buffer.concat(received))).toEqual([0xff, 0x00, 0x80, 0x7f]);
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
