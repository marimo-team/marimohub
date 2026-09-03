export interface KubernetesConfigLoader {
	loadFromCluster(): void;
	loadFromDefault(): void;
}

export function loadKubernetesConfiguration(
	config: KubernetesConfigLoader,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const host = env.KUBERNETES_SERVICE_HOST?.trim();
	const port = env.KUBERNETES_SERVICE_PORT?.trim();
	if (!host && !port) {
		config.loadFromDefault();
		return;
	}
	if (!host || !port) {
		throw new Error('In-cluster Kubernetes configuration is incomplete.');
	}
	config.loadFromCluster();
}
