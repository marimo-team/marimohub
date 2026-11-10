import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as coreweave from '@marimo-hub/compute-coreweave';
import { makeCompute } from './compute';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const annotation = 'traefik.ingress.kubernetes.io/router.middlewares';
const annotationsKey = 'MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_ANNOTATIONS';
const middlewaresKey = 'MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_MIDDLEWARES';
const compressionKey = 'MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_COMPRESSION_MIDDLEWARE';

interface Container {
	envFrom: { configMapRef?: { name: string }; secretRef?: { name: string } }[];
	env: { name: string; value: string }[];
}

interface Resource {
	kind: string;
	metadata: { name: string; namespace?: string };
	data?: Record<string, string>;
	stringData?: Record<string, string>;
	spec?: { template: { spec: { containers: Container[] } } };
}

function yamlDocuments(input: string): Resource[] {
	return JSON.parse(
		execFileSync(
			'ruby',
			['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_stream(STDIN.read).compact)'],
			{
				input,
				encoding: 'utf8',
				timeout: 10_000,
			},
		),
	) as Resource[];
}

function environment(container: Container, resources: Resource[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const source of container.envFrom) {
		const kind = source.secretRef ? 'Secret' : 'ConfigMap';
		const name = source.secretRef?.name ?? source.configMapRef?.name;
		const resource = resources.find((entry) => entry.kind === kind && entry.metadata.name === name);
		if (!resource) throw new Error(`Missing ${kind} ${name}`);
		for (const [key, value] of Object.entries(resource.data ?? {})) {
			env[key] = kind === 'Secret' ? Buffer.from(value, 'base64').toString('utf8') : value;
		}
		Object.assign(env, resource.stringData);
	}
	for (const entry of container.env) env[entry.name] = entry.value;
	return env;
}

afterEach(() => vi.restoreAllMocks());

describe.runIf(process.env.MARIMOHUB_HELM_TEST === 'true')('Helm kernel compression', () => {
	it.each([
		{ maintenance: true, duplicate: false },
		{ maintenance: false, duplicate: false },
		{ maintenance: true, duplicate: true },
		{ maintenance: false, duplicate: true },
	])(
		'preserves external Secret middleware ($maintenance, duplicate=$duplicate)',
		({ maintenance, duplicate }) => {
			const rendered = execFileSync(
				'helm',
				[
					'template',
					'test',
					'charts/marimohub',
					'-f',
					'charts/marimohub/ci/kernel-compression-values.yaml',
					'--set',
					`maintenance.enabled=${maintenance}`,
				],
				{ cwd: root, encoding: 'utf8', timeout: 15_000 },
			);
			const resources = yamlDocuments(rendered);
			const [secret] = yamlDocuments(
				readFileSync(
					new URL('../../../charts/marimohub/ci/kernel-compression-secret.yaml', import.meta.url),
					'utf8',
				),
			);
			const middleware = resources.find((entry) => entry.kind === 'Middleware');
			expect(middleware).toBeDefined();
			const compression = `${middleware!.metadata.namespace}-${middleware!.metadata.name}@kubernetescrd`;
			if (duplicate) secret.stringData![middlewaresKey] += `, ${compression}`;
			resources.push(secret);
			const deployments = resources.filter((entry) => entry.kind === 'Deployment');
			expect(deployments).toHaveLength(maintenance ? 2 : 1);
			const createPublisher = vi.spyOn(coreweave, 'createKernelIngressPublisher');
			for (const deployment of deployments) {
				const container = deployment.spec!.template.spec.containers[0];
				const env = environment(container, resources);
				expect(env[annotationsKey]).toBe(secret.stringData![annotationsKey]);
				expect(env[middlewaresKey]).toBe(secret.stringData![middlewaresKey]);
				expect(env[compressionKey]).toBe(compression);
				makeCompute(env);
				expect(createPublisher).toHaveBeenLastCalledWith({
					namespace: 'sandboxes',
					ingressClassName: 'traefik',
					ingressAnnotations: {
						[annotation]: `sandboxes-auth@kubernetescrd,sandboxes-rate-limit@kubernetescrd,${compression}`,
						'example.com/source': 'external-secret',
					},
				});
			}
			expect(createPublisher).toHaveBeenCalledTimes(deployments.length);
		},
	);
});
