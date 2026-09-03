import { describe, expect, it, vi } from 'vitest';
import { loadKubernetesConfiguration } from './kubeConfig';

function loader() {
	return {
		loadFromCluster: vi.fn(),
		loadFromDefault: vi.fn(),
	};
}

describe('loadKubernetesConfiguration', () => {
	it('loads the default kubeconfig outside Kubernetes', () => {
		const config = loader();
		loadKubernetesConfiguration(config, {});
		expect(config.loadFromDefault).toHaveBeenCalledOnce();
		expect(config.loadFromCluster).not.toHaveBeenCalled();
	});

	it('loads the in-cluster configuration when Kubernetes service variables exist', () => {
		const config = loader();
		loadKubernetesConfiguration(config, {
			KUBERNETES_SERVICE_HOST: '10.0.0.1',
			KUBERNETES_SERVICE_PORT: '443',
		});
		expect(config.loadFromCluster).toHaveBeenCalledOnce();
		expect(config.loadFromDefault).not.toHaveBeenCalled();
	});

	it.each([
		{ KUBERNETES_SERVICE_HOST: '10.0.0.1' },
		{ KUBERNETES_SERVICE_PORT: '443' },
		{ KUBERNETES_SERVICE_HOST: ' ', KUBERNETES_SERVICE_PORT: '443' },
		{ KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: ' ' },
	])('rejects partial in-cluster configuration %#', (env) => {
		const config = loader();
		expect(() => loadKubernetesConfiguration(config, env)).toThrow(
			'In-cluster Kubernetes configuration is incomplete.',
		);
		expect(config.loadFromCluster).not.toHaveBeenCalled();
		expect(config.loadFromDefault).not.toHaveBeenCalled();
	});

	it('does not hide an in-cluster loading failure with a local kubeconfig fallback', () => {
		const config = loader();
		config.loadFromCluster.mockImplementation(() => {
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
