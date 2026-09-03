import { existsSync } from 'node:fs';
import { isIPv6 } from 'node:net';

const SERVICE_ACCOUNT_ROOT = '/var/run/secrets/kubernetes.io/serviceaccount';
const SERVICE_ACCOUNT_CA_PATH = `${SERVICE_ACCOUNT_ROOT}/ca.crt`;
const SERVICE_ACCOUNT_TOKEN_PATH = `${SERVICE_ACCOUNT_ROOT}/token`;

export interface KubernetesConfigLoader {
	loadFromClusterAndUser(
		cluster: {
			name: string;
			caFile: string;
			server: string;
			skipTLSVerify: boolean;
		},
		user: {
			name: string;
			authProvider: {
				name: string;
				config: { tokenFile: string };
			};
		},
	): void;
	loadFromDefault(): void;
}

export function loadKubernetesConfiguration(
	config: KubernetesConfigLoader,
	env: NodeJS.ProcessEnv = process.env,
	serviceAccountTokenExists: () => boolean = () => existsSync(SERVICE_ACCOUNT_TOKEN_PATH),
): void {
	const host = env.KUBERNETES_SERVICE_HOST?.trim();
	const port = env.KUBERNETES_SERVICE_PORT?.trim();
	if (!host || !port) {
		if (host || port) {
			throw new Error('In-cluster Kubernetes configuration is incomplete.');
		}
		if (!serviceAccountTokenExists()) {
			config.loadFromDefault();
			return;
		}
	}
	const serverHost = host && isIPv6(host) ? `[${host}]` : (host ?? 'kubernetes.default.svc');
	const serverPort = port ?? '443';
	const scheme = ['80', '8080', '8001'].includes(serverPort) ? 'http' : 'https';
	config.loadFromClusterAndUser(
		{
			name: 'inCluster',
			caFile: SERVICE_ACCOUNT_CA_PATH,
			server: `${scheme}://${serverHost}:${serverPort}`,
			skipTLSVerify: false,
		},
		{
			name: 'inClusterUser',
			authProvider: {
				name: 'tokenFile',
				config: { tokenFile: SERVICE_ACCOUNT_TOKEN_PATH },
			},
		},
	);
}
