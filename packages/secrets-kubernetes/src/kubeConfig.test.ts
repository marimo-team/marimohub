import { describe, expect, it, vi } from 'vitest';
import { loadKubernetesConfiguration } from './kubeConfig';

function loader() {
	return {
		loadFromClusterAndUser: vi.fn(),
		loadFromDefault: vi.fn(),
	};
}

describe('loadKubernetesConfiguration', () => {
	it('loads the default kubeconfig outside Kubernetes', () => {
		const config = loader();
		loadKubernetesConfiguration(config, {}, () => false);
		expect(config.loadFromDefault).toHaveBeenCalledOnce();
		expect(config.loadFromClusterAndUser).not.toHaveBeenCalled();
	});

	it('loads the in-cluster configuration from the supplied environment', () => {
		const config = loader();
		loadKubernetesConfiguration(config, {
			KUBERNETES_SERVICE_HOST: '10.0.0.1',
			KUBERNETES_SERVICE_PORT: '443',
		});
		expect(config.loadFromClusterAndUser).toHaveBeenCalledWith(
			{
				name: 'inCluster',
				caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
				server: 'https://10.0.0.1:443',
				skipTLSVerify: false,
			},
			{
				name: 'inClusterUser',
				authProvider: {
					name: 'tokenFile',
					config: { tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token' },
				},
			},
		);
		expect(config.loadFromDefault).not.toHaveBeenCalled();
	});

	it('uses the Kubernetes service DNS name when only a mounted token identifies the cluster', () => {
		const config = loader();
		loadKubernetesConfiguration(config, {}, () => true);
		expect(config.loadFromClusterAndUser).toHaveBeenCalledWith(
			expect.objectContaining({ server: 'https://kubernetes.default.svc:443' }),
			expect.any(Object),
		);
		expect(config.loadFromDefault).not.toHaveBeenCalled();
	});

	it('formats an IPv6 API address and preserves the client HTTP-port behavior', () => {
		const config = loader();
		loadKubernetesConfiguration(config, {
			KUBERNETES_SERVICE_HOST: '2001:db8::1',
			KUBERNETES_SERVICE_PORT: '8080',
		});
		expect(config.loadFromClusterAndUser).toHaveBeenCalledWith(
			expect.objectContaining({ server: 'http://[2001:db8::1]:8080' }),
			expect.any(Object),
		);
	});

	it.each([
		{ KUBERNETES_SERVICE_HOST: '10.0.0.1' },
		{ KUBERNETES_SERVICE_PORT: '443' },
		{ KUBERNETES_SERVICE_HOST: ' ', KUBERNETES_SERVICE_PORT: '443' },
		{ KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: ' ' },
	])('rejects partial in-cluster configuration %#', (env) => {
		const config = loader();
		expect(() => loadKubernetesConfiguration(config, env, () => true)).toThrow(
			'In-cluster Kubernetes configuration is incomplete.',
		);
		expect(config.loadFromClusterAndUser).not.toHaveBeenCalled();
		expect(config.loadFromDefault).not.toHaveBeenCalled();
	});

	it('does not hide an in-cluster loading failure with a local kubeconfig fallback', () => {
		const config = loader();
		config.loadFromClusterAndUser.mockImplementation(() => {
			throw new Error('cluster configuration failed');
		});
		expect(() =>
			loadKubernetesConfiguration(config, {
				KUBERNETES_SERVICE_HOST: '10.0.0.1',
				KUBERNETES_SERVICE_PORT: '443',
			}),
		).toThrow('cluster configuration failed');
		expect(config.loadFromDefault).not.toHaveBeenCalled();
	});
});
