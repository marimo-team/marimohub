import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SandboxId } from '@marimo-hub/core/ids';
import { podManifest } from './client';
import { loadPodTemplateFile, parsePodTemplate, validatePodTemplate } from './podTemplate';
import type { KubernetesPodTemplate } from './podTemplate';
import { MANAGED_BY_LABEL, SANDBOX_ID_ANNOTATION, SANDBOX_NAME_LABEL } from './shared';
import type { EnsureSandboxOptions } from './shared';
import { projectedToken, withContainer, withSpec } from './podTemplate.testUtils';

const options: EnsureSandboxOptions = {
	name: 'mh-first',
	namespace: 'fabric-marimohub-kernels',
	sandboxId: 'sb-first' as SandboxId,
	image: 'registry.example.com/fabric/runtime:1.0.27',
	ports: [
		{ port: 2718, host: '' },
		{ port: 8443, host: '' },
	],
};

describe('parsePodTemplate', () => {
	it('parses the projected service account token example, including octal permissions', () => {
		const template = parsePodTemplate(projectedToken);
		expect(template.spec?.volumes).toEqual([
			{
				name: 'gateway-token',
				projected: {
					defaultMode: 0o444,
					sources: [
						{
							serviceAccountToken: {
								audience: 'fabric-gateway',
								expirationSeconds: 600,
								path: 'token',
							},
						},
					],
				},
			},
		]);
		expect(template.spec?.containers?.[0].securityContext).toEqual({
			allowPrivilegeEscalation: false,
			capabilities: { drop: ['ALL'] },
		});
	});

	it.each([
		['empty object', {}],
		['empty spec', { spec: {} }],
		[
			'metadata only',
			{ metadata: { labels: { team: 'data' }, annotations: { 'example.com/id': '123' } } },
		],
		[
			'pod settings only',
			withSpec({ serviceAccountName: 'kernel', automountServiceAccountToken: false }),
		],
		['container name only', withContainer({})],
		['empty optional arrays', withContainer({ env: [], envFrom: [], volumeMounts: [] })],
		[
			'string env values',
			withContainer({
				env: [
					{ name: 'EMPTY', value: '' },
					{ name: 'ENABLED', value: 'true' },
				],
			}),
		],
		[
			'secret env',
			withContainer({
				env: [
					{
						name: 'TOKEN',
						valueFrom: { secretKeyRef: { name: 'api', key: 'token', optional: false } },
					},
				],
			}),
		],
		[
			'configmap env',
			withContainer({
				env: [{ name: 'URL', valueFrom: { configMapKeyRef: { name: 'config', key: 'url' } } }],
			}),
		],
		[
			'downward API env',
			withContainer({
				env: [{ name: 'POD', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } }],
			}),
		],
		[
			'resource env',
			withContainer({
				env: [
					{
						name: 'CPU',
						valueFrom: { resourceFieldRef: { resource: 'limits.cpu', divisor: '1m' } },
					},
				],
			}),
		],
		[
			'envFrom',
			withContainer({
				envFrom: [
					{ prefix: 'APP_', configMapRef: { name: 'config' } },
					{ secretRef: { name: 'secret' } },
				],
			}),
		],
		[
			'pod security',
			withSpec({
				securityContext: {
					runAsUser: 0,
					runAsGroup: 10,
					runAsNonRoot: false,
					fsGroup: 10,
					supplementalGroups: [20],
					fsGroupChangePolicy: 'OnRootMismatch',
				},
			}),
		],
		[
			'container security',
			withContainer({
				securityContext: {
					readOnlyRootFilesystem: true,
					privileged: false,
					capabilities: { add: ['NET_BIND_SERVICE'], drop: ['ALL'] },
					seccompProfile: { type: 'Localhost', localhostProfile: 'profiles/kernel.json' },
				},
			}),
		],
		[
			'scheduling',
			withSpec({
				nodeSelector: { workload: 'notebooks' },
				tolerations: [{ key: 'gpu', operator: 'Exists', effect: 'NoSchedule' }],
				affinity: { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [] } },
				runtimeClassName: 'gvisor',
			}),
		],
		[
			'DNS and networking',
			withSpec({
				dnsPolicy: 'None',
				dnsConfig: { nameservers: ['10.0.0.10'] },
				hostNetwork: false,
				hostPID: false,
				hostIPC: false,
			}),
		],
		[
			'other Kubernetes fields',
			withSpec({
				priorityClassName: 'notebooks',
				schedulerName: 'custom',
				hostAliases: [{ ip: '10.0.0.1', hostnames: ['api.internal'] }],
			}),
		],
		['zero grace period', withSpec({ terminationGracePeriodSeconds: 0 })],
		[
			'multiple pull secrets',
			withSpec({ imagePullSecrets: [{ name: 'primary' }, { name: 'fallback' }] }),
		],
	] as const)('accepts %s in JSON and YAML flow syntax', (_label, value) => {
		expect(parsePodTemplate(JSON.stringify(value))).toEqual(value);
	});

	it.each([
		['emptyDir', { emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } }],
		[
			'configMap',
			{ configMap: { name: 'config', items: [{ key: 'config', path: 'config.json' }] } },
		],
		['secret', { secret: { secretName: 'credentials', defaultMode: 0o400 } }],
		['PVC', { persistentVolumeClaim: { claimName: 'shared', readOnly: true } }],
		[
			'CSI',
			{
				csi: {
					driver: 'secrets-store.csi.k8s.io',
					readOnly: true,
					volumeAttributes: { secretProviderClass: 'vault' },
				},
			},
		],
		[
			'downwardAPI',
			{ downwardAPI: { items: [{ path: 'name', fieldRef: { fieldPath: 'metadata.name' } }] } },
		],
		[
			'mixed projection',
			{
				projected: {
					sources: [
						{ secret: { name: 'api' } },
						{ configMap: { name: 'config' } },
						{ serviceAccountToken: { path: 'token' } },
					],
				},
			},
		],
	] as const)('preserves %s volumes and mounts', (_label, source) => {
		const input = withSpec({
			volumes: [{ name: 'data', ...source }],
			containers: [
				{ name: 'marimo', volumeMounts: [{ name: 'data', mountPath: '/data', readOnly: true }] },
			],
		});
		expect(parsePodTemplate(JSON.stringify(input))).toEqual(input);
	});

	it('expands bounded YAML anchors without merging lists', () => {
		expect(
			parsePodTemplate(`spec:
  securityContext: &security
    runAsNonRoot: true
  containers:
    - name: marimo
      securityContext: *security
`),
		).toEqual(
			withSpec({
				securityContext: { runAsNonRoot: true },
				containers: [{ name: 'marimo', securityContext: { runAsNonRoot: true } }],
			}),
		);
	});

	it.each([
		'',
		'# comment only',
		'null',
		'true',
		'42',
		'plain text',
		'[]',
		'- spec: {}',
		'spec: [',
		'spec: {}\nspec: {}',
		'{}\n---\n{}',
		'spec: !custom {}',
		'spec: &self {affinity: *self}',
	])('rejects malformed YAML or a non-object document: %s', (source) => {
		expect(() => parsePodTemplate(source)).toThrow();
	});

	it('does not echo a secret from a malformed YAML document', () => {
		expect(() => parsePodTemplate('spec: { env: [super-secret-token')).toThrow(
			/^Pod template must contain one valid YAML or JSON document$/,
		);
	});

	it('rejects excessive alias expansion', () => {
		const source = `metadata:
  annotations:
    a: &a [a, a, a, a, a, a, a, a, a, a]
    b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
    c: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]`;
		expect(() => parsePodTemplate(source)).toThrow(/excessive YAML aliases/);
	});
});

describe('validatePodTemplate', () => {
	it.each([
		['wrong kind', { kind: 'Deployment' }],
		['wrong API', { apiVersion: 'apps/v1' }],
		['bare PodSpec', { serviceAccountName: 'kernel' }],
		['null metadata', { metadata: null }],
		['metadata array', { metadata: [] }],
		['numeric label', { metadata: { labels: { count: 3 } } }],
		['boolean annotation', { metadata: { annotations: { enabled: true } } }],
		['null spec', withSpec(null)],
		['spec array', withSpec([])],
		['status', { status: {} }],
		['wrong container name', withContainer({ name: 'kernel' })],
		['container map', withSpec({ containers: { marimo: {} } })],
		['empty containers', withSpec({ containers: [] })],
		['unnamed container', withSpec({ containers: [{}] })],
		['sidecar', withSpec({ containers: [{ name: 'marimo' }, { name: 'sidecar' }] })],
		['duplicate container', withSpec({ containers: [{ name: 'marimo' }, { name: 'marimo' }] })],
		['init container', withSpec({ initContainers: [] })],
		['ephemeral container', withSpec({ ephemeralContainers: [] })],
		['pod resources', withSpec({ resources: {} })],
		['serviceAccount alias', withSpec({ serviceAccount: 'kernel' })],
		['restart policy', withSpec({ restartPolicy: 'Always' })],
		['string boolean', withSpec({ automountServiceAccountToken: 'false' })],
		['negative grace', withSpec({ terminationGracePeriodSeconds: -1 })],
		['fractional UID', withSpec({ securityContext: { runAsUser: 1.5 } })],
		['string UID', withSpec({ securityContext: { runAsUser: '1000' } })],
		['null security', withSpec({ securityContext: null })],
		['scalar security', withContainer({ securityContext: false })],
		[
			'invalid seccomp',
			withContainer({ securityContext: { seccompProfile: { type: 'Default' } } }),
		],
		['capability string', withContainer({ securityContext: { capabilities: { drop: 'ALL' } } })],
		['bad pull policy', withContainer({ imagePullPolicy: 'ifnotpresent' })],
		['env map', withContainer({ env: { TOKEN: 'value' } })],
		['numeric env value', withContainer({ env: [{ name: 'PORT', value: 123 }] })],
		['boolean env value', withContainer({ env: [{ name: 'ENABLED', value: true }] })],
		[
			'env value and source',
			withContainer({
				env: [
					{ name: 'TOKEN', value: '', valueFrom: { secretKeyRef: { name: 'api', key: 'token' } } },
				],
			}),
		],
		['empty valueFrom', withContainer({ env: [{ name: 'TOKEN', valueFrom: {} }] })],
		[
			'secret missing key',
			withContainer({ env: [{ name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'api' } } }] }),
		],
		['empty envFrom', withContainer({ envFrom: [{}] })],
		[
			'ambiguous envFrom',
			withContainer({
				envFrom: [{ secretRef: { name: 'api' }, configMapRef: { name: 'config' } }],
			}),
		],
		['mount map', withContainer({ volumeMounts: { data: '/data' } })],
		['mount missing path', withContainer({ volumeMounts: [{ name: 'data' }] })],
		['volume map', withSpec({ volumes: { data: {} } })],
		['volume without source', withSpec({ volumes: [{ name: 'data' }] })],
		[
			'volume with two sources',
			withSpec({ volumes: [{ name: 'data', emptyDir: {}, secret: { secretName: 'api' } }] }),
		],
		[
			'projected sources map',
			withSpec({ volumes: [{ name: 'token', projected: { sources: {} } }] }),
		],
		['empty projection', withSpec({ volumes: [{ name: 'token', projected: { sources: [] } }] })],
		['empty source', withSpec({ volumes: [{ name: 'token', projected: { sources: [{}] } }] })],
		[
			'short token lifetime',
			withSpec({
				volumes: [
					{
						name: 'token',
						projected: {
							sources: [{ serviceAccountToken: { path: 'token', expirationSeconds: 599 } }],
						},
					},
				],
			}),
		],
		[
			'token missing path',
			withSpec({
				volumes: [
					{ name: 'token', projected: { sources: [{ serviceAccountToken: { audience: 'api' } }] } },
				],
			}),
		],
		[
			'invalid mode',
			withSpec({
				volumes: [
					{
						name: 'token',
						projected: { defaultMode: 888, sources: [{ serviceAccountToken: { path: 'token' } }] },
					},
				],
			}),
		],
		['numeric selector', withSpec({ nodeSelector: { gpu: 1 } })],
		['tolerations object', withSpec({ tolerations: {} })],
	] as const)('rejects %s', (_label, input) => {
		expect(() => validatePodTemplate(input)).toThrow(/Invalid pod template/);
	});

	it.each(['image', 'command', 'args', 'ports', 'resources'])(
		'rejects managed container field %s, including null',
		(field) => {
			for (const value of ['override', [], {}, null]) {
				expect(() => validatePodTemplate(withContainer({ [field]: value }))).toThrow(
					`spec.containers.0.${field}`,
				);
			}
		},
	);

	it.each([
		'name',
		'namespace',
		'generateName',
		'ownerReferences',
		'finalizers',
		'uid',
		'resourceVersion',
	])('rejects managed metadata field %s', (field) => {
		expect(() => validatePodTemplate({ metadata: { [field]: 'override' } })).toThrow(/metadata/);
	});

	it.each([MANAGED_BY_LABEL, SANDBOX_NAME_LABEL])('rejects reserved label %s', (label) => {
		expect(() => validatePodTemplate({ metadata: { labels: { [label]: 'override' } } })).toThrow(
			/management or selector/,
		);
	});

	it('rejects the sandbox identity annotation', () => {
		expect(() =>
			validatePodTemplate({ metadata: { annotations: { [SANDBOX_ID_ANNOTATION]: 'override' } } }),
		).toThrow(/sandbox identity/);
	});

	it.each([
		[
			'volumes',
			withSpec({
				volumes: [
					{ name: 'data', emptyDir: {} },
					{ name: 'data', emptyDir: {} },
				],
			}),
		],
		[
			'env',
			withContainer({
				env: [
					{ name: 'TOKEN', value: 'a' },
					{ name: 'TOKEN', value: 'b' },
				],
			}),
		],
		[
			'mount paths',
			withSpec({
				volumes: [{ name: 'data', emptyDir: {} }],
				containers: [
					{
						name: 'marimo',
						volumeMounts: [
							{ name: 'data', mountPath: '/data' },
							{ name: 'data', mountPath: '/data' },
						],
					},
				],
			}),
		],
		['pull secrets', withSpec({ imagePullSecrets: [{ name: 'registry' }, { name: 'registry' }] })],
	] as const)('rejects duplicate %s', (_label, input) => {
		expect(() => validatePodTemplate(input)).toThrow(/duplicate entries/);
	});

	it('rejects mounts without a corresponding volume', () => {
		expect(() =>
			validatePodTemplate(
				withContainer({ volumeMounts: [{ name: 'missing', mountPath: '/data' }] }),
			),
		).toThrow(/reference a volume/);
	});

	it('allows the same volume at distinct mount paths', () => {
		const input = withSpec({
			volumes: [{ name: 'data', emptyDir: {} }],
			containers: [
				{
					name: 'marimo',
					volumeMounts: [
						{ name: 'data', mountPath: '/data' },
						{ name: 'data', mountPath: '/other' },
					],
				},
			],
		});
		expect(validatePodTemplate(input)).toEqual(input);
	});

	it('reports the invalid field without exposing an env value', () => {
		expect(() =>
			validatePodTemplate(
				withContainer({ env: [{ name: 'TOKEN', value: { secret: 'super-secret' } }] }),
			),
		).toThrow(/^Invalid pod template at spec.containers.0.env.0.value \(invalid_type\)$/);
	});
});

describe('podManifest with templates', () => {
	it('preserves the projected-token configuration and adds the managed kernel fields', () => {
		const template = parsePodTemplate(projectedToken);
		const pod = podManifest({ ...options, podTemplate: template });
		expect(pod).toMatchObject(template);
		expect(pod.metadata).toEqual({
			name: options.name,
			namespace: options.namespace,
			labels: {
				team: 'fabric',
				[MANAGED_BY_LABEL]: 'marimohub',
				[SANDBOX_NAME_LABEL]: options.name,
			},
			annotations: {
				'example.com/purpose': 'notebook',
				[SANDBOX_ID_ANNOTATION]: options.sandboxId,
			},
		});
		expect(pod.spec?.containers).toHaveLength(1);
		expect(pod.spec?.containers[0]).toMatchObject({
			name: 'marimo',
			image: options.image,
			command: ['sh', '-c', 'sleep infinity'],
			ports: [
				{ name: 'kernel', containerPort: 2718 },
				{ name: 'port-8443', containerPort: 8443 },
			],
			imagePullPolicy: 'IfNotPresent',
		});
	});

	it.each([{}, { spec: {} }, { spec: { containers: [{ name: 'marimo' as const }] } }])(
		'keeps defaults for a minimal template %j',
		(podTemplate) => {
			expect(podManifest({ ...options, podTemplate })).toEqual(podManifest(options));
		},
	);

	it('explicit settings override only their corresponding template fields', () => {
		const template = parsePodTemplate(projectedToken);
		template.spec!.imagePullSecrets = [{ name: 'from-template' }];
		template.spec!.containers![0].imagePullPolicy = 'Never';
		const pod = podManifest({
			...options,
			podTemplate: template,
			serviceAccountName: 'override',
			imagePullSecret: 'configured',
			imagePullPolicy: 'Always',
			runAsUser: 2000,
			extraLabels: { team: 'configured' },
			resources: {
				cpu: '1500m',
				memory: '2Gi',
				gpu: '1',
				profileLimits: { cpu: true, memory: true },
			},
		});
		expect(pod.metadata?.labels?.team).toBe('configured');
		expect(pod.spec).toMatchObject({
			serviceAccountName: 'override',
			imagePullSecrets: [{ name: 'configured' }],
			securityContext: {
				runAsUser: 2000,
				runAsNonRoot: true,
				fsGroup: 2000,
				seccompProfile: { type: 'RuntimeDefault' },
			},
		});
		expect(pod.spec?.containers[0]).toMatchObject({
			imagePullPolicy: 'Always',
			securityContext: template.spec?.containers?.[0]?.securityContext,
			resources: {
				requests: { cpu: '1500m', memory: '2Gi' },
				limits: { cpu: '1500m', memory: '2Gi', 'nvidia.com/gpu': '1' },
			},
		});
		expect(pod.spec?.volumes).toEqual(template.spec?.volumes);
	});

	it('uses the template pull policy before the image-derived default', () => {
		const pod = podManifest({
			...options,
			image: 'runtime:latest',
			podTemplate: { spec: { containers: [{ name: 'marimo', imagePullPolicy: 'Never' }] } },
		});
		expect(pod.spec?.containers[0]?.imagePullPolicy).toBe('Never');
	});

	it('retains template pull secrets when no explicit secret is configured', () => {
		const imagePullSecrets = [{ name: 'primary' }, { name: 'fallback' }];
		expect(
			podManifest({ ...options, podTemplate: { spec: { imagePullSecrets } } }).spec
				?.imagePullSecrets,
		).toEqual(imagePullSecrets);
	});

	it('applies an explicit root UID while retaining other security settings', () => {
		const pod = podManifest({
			...options,
			podTemplate: parsePodTemplate(projectedToken),
			runAsUser: 0,
		});
		expect(pod.spec?.securityContext).toEqual({
			runAsUser: 0,
			runAsNonRoot: false,
			fsGroup: 0,
			seccompProfile: { type: 'RuntimeDefault' },
		});
	});

	it('honors zero termination grace rather than replacing it with the default', () => {
		expect(
			podManifest({ ...options, podTemplate: { spec: { terminationGracePeriodSeconds: 0 } } }).spec
				?.terminationGracePeriodSeconds,
		).toBe(0);
	});

	it('does not mutate or share nested template data between sandboxes', () => {
		const template = parsePodTemplate(projectedToken);
		const original = structuredClone(template);
		const first = podManifest({ ...options, podTemplate: template });
		first.spec!.volumes![0].projected!.sources![0].serviceAccountToken!.audience = 'changed';
		first.spec!.containers[0].env![0].value = 'changed';
		first.metadata!.labels!.team = 'changed';
		const second = podManifest({
			...options,
			name: 'mh-second',
			sandboxId: 'sb-second' as SandboxId,
			podTemplate: template,
		});
		expect(template).toEqual(original);
		expect(second.spec).toMatchObject(original.spec!);
		expect(second.metadata?.name).toBe('mh-second');
		expect(second.metadata?.annotations?.[SANDBOX_ID_ANNOTATION]).toBe('sb-second');
	});

	it('validates templates before rendering even for direct client callers', () => {
		expect(() =>
			podManifest({
				...options,
				podTemplate: {
					spec: { containers: [{ name: 'other' }] },
				} as unknown as KubernetesPodTemplate,
			}),
		).toThrow(/spec.containers.0.name/);
	});
});

describe('loadPodTemplateFile', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'pod-template-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('follows a ConfigMap-style symlink and retains the startup snapshot after rotation', () => {
		writeFileSync(join(dir, 'revision-1'), 'spec: {serviceAccountName: first}');
		writeFileSync(join(dir, 'revision-2'), 'spec: {serviceAccountName: second}');
		const path = join(dir, 'pod.yaml');
		symlinkSync('revision-1', path);
		const first = loadPodTemplateFile(path);
		symlinkSync('revision-2', join(dir, 'next'));
		renameSync(join(dir, 'next'), path);
		expect(first.spec?.serviceAccountName).toBe('first');
		expect(loadPodTemplateFile(path).spec?.serviceAccountName).toBe('second');
	});

	it('reports a broken symlink as a file-read error', () => {
		const path = join(dir, 'pod.yaml');
		symlinkSync('missing-revision', path);
		expect(() => loadPodTemplateFile(path)).toThrow(/Cannot read pod template file/);
	});

	it('loads a relative path with spaces without depending on the filename extension', () => {
		const path = join(dir, 'kernel template.conf');
		writeFileSync(path, projectedToken);
		expect(loadPodTemplateFile(relative(process.cwd(), path))).toEqual(
			parsePodTemplate(projectedToken),
		);
	});

	it('rejects an empty file rather than treating it as an absent template', () => {
		const path = join(dir, 'empty.yaml');
		writeFileSync(path, '');
		expect(() => loadPodTemplateFile(path)).toThrow(/Invalid pod template/);
	});

	it.each(['yaml', 'json'])('loads a %s file once', (extension) => {
		const path = join(dir, `pod.${extension}`);
		const expected = parsePodTemplate(projectedToken);
		writeFileSync(path, extension === 'yaml' ? projectedToken : JSON.stringify(expected));
		const loaded = loadPodTemplateFile(path);
		writeFileSync(path, '{}');
		expect(loaded).toEqual(expected);
	});

	it('reports unreadable files without file contents', () => {
		expect(() => loadPodTemplateFile(join(dir, 'missing.yaml'))).toThrow(
			/Cannot read pod template file/,
		);
		expect(() => loadPodTemplateFile(dir)).toThrow(/Cannot read pod template file/);
	});
});
