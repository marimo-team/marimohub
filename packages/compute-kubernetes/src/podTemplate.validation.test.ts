import { describe, expect, it } from 'vitest';
import { validatePodTemplate } from './podTemplate';
import { withContainer, withSpec } from './podTemplate.testUtils';

const resourceReferences = [
	['service account', (name: string) => withSpec({ serviceAccountName: name })],
	['runtime class', (name: string) => withSpec({ runtimeClassName: name })],
	['image pull secret', (name: string) => withSpec({ imagePullSecrets: [{ name }] })],
	...(['secretKeyRef', 'configMapKeyRef'] as const).map(
		(source) =>
			[
				source,
				(name: string) =>
					withContainer({
						env: [{ name: 'TOKEN', valueFrom: { [source]: { name, key: 'TOKEN' } } }],
					}),
			] as const,
	),
	...(['secretRef', 'configMapRef'] as const).map(
		(source) =>
			[source, (name: string) => withContainer({ envFrom: [{ [source]: { name } }] })] as const,
	),
] as const;

describe.each(resourceReferences)('pod template %s names', (_label, template) => {
	it.each(['a', '0', 'kernel-config', 'fabric.kernel', 'a'.repeat(253)])(
		'accepts DNS subdomain %#',
		(name) => {
			const input = template(name);
			expect(validatePodTemplate(input)).toEqual(input);
		},
	);

	it.each([
		'',
		'Kernel',
		'kernel_config',
		'has space',
		'-kernel',
		'kernel-',
		'.kernel',
		'kernel.',
		'kernel..config',
		'kernel/config',
		'a'.repeat(254),
	])('rejects invalid DNS subdomain %#', (name) => {
		expect(() => validatePodTemplate(template(name))).toThrow(/Invalid pod template at spec/);
	});
});

const volumeTemplate = (name: string, mountName = name, mountPath = '/data') =>
	withSpec({
		volumes: [{ name, emptyDir: {} }],
		containers: [{ name: 'marimo', volumeMounts: [{ name: mountName, mountPath }] }],
	});

describe('pod template volume names and paths', () => {
	it.each(['a', '0', 'gateway-token', 'a'.repeat(63)])('accepts DNS label %#', (name) => {
		const input = volumeTemplate(name);
		expect(validatePodTemplate(input)).toEqual(input);
	});

	it.each([
		'',
		'Data',
		'has space',
		'gateway_token',
		'gateway.token',
		'-data',
		'data-',
		'a'.repeat(64),
	])('rejects invalid volume and mount names %#', (name) => {
		expect(() => validatePodTemplate(withSpec({ volumes: [{ name, emptyDir: {} }] }))).toThrow(
			/spec.volumes.0.name/,
		);
		expect(() => validatePodTemplate(volumeTemplate('data', name))).toThrow(
			/spec.containers.0.volumeMounts.0.name/,
		);
	});

	// Kubelet makes relative mount paths absolute before passing them to the runtime.
	it.each(['/var/run/secrets', 'var/run/secrets'])('preserves mount path %s', (path) => {
		const input = volumeTemplate('data', 'data', path);
		expect(validatePodTemplate(input)).toEqual(input);
	});

	it('does not apply DNS rules to environment names, keys, capabilities, or token audiences', () => {
		const input = withSpec({
			volumes: [
				{
					name: 'token',
					projected: {
						sources: [
							{
								serviceAccountToken: { audience: 'https://API.example.com', path: 'secrets/TOKEN' },
							},
						],
					},
				},
			],
			containers: [
				{
					name: 'marimo',
					env: [
						{
							name: 'API_TOKEN',
							valueFrom: { secretKeyRef: { name: 'api.secret', key: 'API_TOKEN' } },
						},
					],
					securityContext: { capabilities: { drop: ['ALL'] } },
				},
			],
		});
		expect(validatePodTemplate(input)).toEqual(input);
	});
});

const securityContexts = [
	['pod', (seccompProfile: unknown) => withSpec({ securityContext: { seccompProfile } })],
	[
		'container',
		(seccompProfile: unknown) => withContainer({ securityContext: { seccompProfile } }),
	],
] as const;

describe.each(securityContexts)('%s seccomp profiles', (_label, template) => {
	it.each([
		{ type: 'RuntimeDefault' },
		{ type: 'Unconfined' },
		{ type: 'Localhost', localhostProfile: 'profiles/kernel.json' },
	])('accepts valid profile %j', (profile) => {
		const input = template(profile);
		expect(validatePodTemplate(input)).toEqual(input);
	});

	it.each([
		{ type: 'Localhost' },
		{ type: 'Localhost', localhostProfile: '' },
		{ type: 'Localhost', localhostProfile: null },
		{ type: 'Localhost', localhostProfile: '/profiles/kernel.json' },
		{ type: 'Localhost', localhostProfile: '../kernel.json' },
		{ type: 'Localhost', localhostProfile: 'profiles/../kernel.json' },
		{ type: 'RuntimeDefault', localhostProfile: 'kernel.json' },
		{ type: 'Unconfined', localhostProfile: 'kernel.json' },
		{ type: 'RuntimeDefault', localhostProfile: '' },
		{ type: 'Unconfined', localhostProfile: null },
		{ type: 'Unknown' },
		{},
	])('rejects malformed profile %j', (profile) => {
		expect(() => validatePodTemplate(template(profile))).toThrow(/securityContext.seccompProfile/);
	});
});
