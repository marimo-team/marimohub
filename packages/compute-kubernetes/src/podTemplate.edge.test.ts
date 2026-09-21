import { describe, expect, it } from 'vitest';
import { parsePodTemplate, validatePodTemplate } from './podTemplate';
import { withContainer } from './podTemplate.testUtils';

const tokenTemplate = (token: Record<string, unknown>, defaultMode?: unknown) => ({
	spec: {
		volumes: [
			{
				name: 'token',
				projected: {
					...(defaultMode === undefined ? {} : { defaultMode }),
					sources: [{ serviceAccountToken: { path: 'token', ...token } }],
				},
			},
		],
	},
});

describe('pod template YAML edge cases', () => {
	it.each(['yes', 'no', 'on', 'off', 'null', '~', '123', '1.5', '.inf', '.nan', '2026-09-21'])(
		'requires quoting an env scalar that YAML coerces: %s',
		(value) => {
			const source = `spec:\n  containers:\n    - name: marimo\n      env:\n        - name: VALUE\n          value: ${value}\n`;
			expect(() => parsePodTemplate(source)).toThrow(/spec.containers.0.env.0.value/);
			expect(parsePodTemplate(source.replace(`value: ${value}`, `value: "${value}"`))).toEqual(
				withContainer({ env: [{ name: 'VALUE', value }] }),
			);
		},
	);

	it.each([
		'spec:\n  containers:\n    - name: marimo\n      env:\n        - name: TOKEN\n          value: first\n          value: second',
		'metadata:\n  annotations:\n    example.com/value: first\n    example.com/value: second',
		'---\n{}\n---',
		'{"spec": {}, "spec": {}}',
		'spec: !!python/object {}',
	])('rejects duplicate keys, extra documents, and invalid tags: %s', (source) => {
		expect(() => parsePodTemplate(source)).toThrow(/one valid YAML or JSON document/);
	});

	it('rejects an unresolved YAML alias without exposing its name', () => {
		expect(() => parsePodTemplate('spec: *sensitive-alias')).toThrow(
			/^Pod template contains .* YAML aliases$/,
		);
	});

	it('accepts a BOM, CRLF, a document marker, comments, and a literal env value', () => {
		const source =
			'\uFEFF---\r\nspec:\r\n  containers:\r\n    - name: marimo # exec target\r\n      env:\r\n        - name: SCRIPT\r\n          value: |\r\n            echo "$TOKEN"\r\n            echo done\r\n...\r\n';
		expect(parsePodTemplate(source)).toEqual(
			withContainer({
				env: [{ name: 'SCRIPT', value: 'echo "$TOKEN"\necho done\n' }],
			}),
		);
	});

	it('expands merge keys while preserving an explicit override', () => {
		expect(
			parsePodTemplate(`spec:
  securityContext: &defaults
    runAsUser: 1000
    runAsNonRoot: true
  containers:
    - name: marimo
      securityContext:
        <<: *defaults
        runAsUser: 2000
`),
		).toMatchObject({
			spec: { containers: [{ securityContext: { runAsUser: 2000, runAsNonRoot: true } }] },
		});
	});
});

describe('pod template token and permission boundaries', () => {
	it.each([0, 0o400, 0o444, 0o777])('accepts permission mode %i', (mode) => {
		const input = tokenTemplate({}, mode);
		expect(validatePodTemplate(input)).toEqual(input);
	});

	it.each([-1, 0o1000, 1.5, '0444', null])('rejects invalid permission mode %j', (mode) => {
		expect(() => validatePodTemplate(tokenTemplate({}, mode))).toThrow(/projected.defaultMode/);
	});

	it.each([600, 601, 3600])('accepts token lifetime %i', (expirationSeconds) => {
		expect(validatePodTemplate(tokenTemplate({ expirationSeconds }))).toMatchObject(
			tokenTemplate({ expirationSeconds }),
		);
	});

	it.each([0, -1, 599, 600.5, '600', null])('rejects token lifetime %j', (expirationSeconds) => {
		expect(() => validatePodTemplate(tokenTemplate({ expirationSeconds }))).toThrow(
			/expirationSeconds/,
		);
	});

	it('preserves projected sources in order and permits the API defaults for audience and lifetime', () => {
		const input = {
			spec: {
				volumes: [
					{
						name: 'identity',
						projected: {
							sources: [
								{ configMap: { name: 'config', items: [{ key: 'url', path: 'url' }] } },
								{ serviceAccountToken: { path: 'token' } },
								{ secret: { name: 'certs', items: [{ key: 'ca', path: 'ca.pem' }] } },
							],
						},
					},
				],
			},
		};
		expect(validatePodTemplate(input)).toEqual(input);
	});

	it('rejects a projection entry with two sources', () => {
		expect(() =>
			validatePodTemplate({
				spec: {
					volumes: [
						{
							name: 'token',
							projected: {
								sources: [
									{ serviceAccountToken: { path: 'token' }, secret: { name: 'credentials' } },
								],
							},
						},
					],
				},
			}),
		).toThrow(/projected.sources.0/);
	});
});

describe('pod template extension boundaries', () => {
	it('preserves admission-webhook annotations and an empty label value', () => {
		const input = {
			metadata: {
				labels: { 'example.com/inject': '' },
				annotations: {
					'example.com/inject': 'true',
					'example.com/config': '{"audience":"fabric"}',
				},
			},
		};
		expect(validatePodTemplate(input)).toEqual(input);
	});

	it.each([
		['environment', withContainer({ env: [{ name: 'URL', value: 'url', futureOption: true }] })],
		[
			'environment source',
			withContainer({
				env: [{ name: 'URL', valueFrom: { futureSource: { name: 'config' } } }],
			}),
		],
		[
			'seccomp',
			{
				spec: {
					securityContext: { seccompProfile: { type: 'RuntimeDefault', futureOption: true } },
				},
			},
		],
		['token projection', tokenTemplate({ futureOption: true })],
		['metadata', { metadata: { futureOption: true } }],
	] as const)('currently rejects unfamiliar fields in %s', (_label, input) => {
		expect(() => validatePodTemplate(input)).toThrow(/unrecognized_keys/);
	});

	it('preserves unfamiliar JSON fields in extensible objects without sharing their references', () => {
		const input = {
			spec: {
				futurePodOption: { items: [null, false, 0, 'value'] },
				securityContext: { futureSecurityOption: { enabled: true } },
				containers: [{ name: 'marimo', futureContainerOption: { value: 1 } }],
			},
		};
		const parsed = validatePodTemplate(input);
		input.spec.futurePodOption.items.push('changed');
		input.spec.securityContext.futureSecurityOption.enabled = false;
		input.spec.containers[0].futureContainerOption.value = 2;
		expect(parsed).toMatchObject({
			spec: {
				futurePodOption: { items: [null, false, 0, 'value'] },
				securityContext: { futureSecurityOption: { enabled: true } },
				containers: [{ futureContainerOption: { value: 1 } }],
			},
		});
	});

	it.each([Infinity, Number.NaN, 1n, () => 'value', Symbol('value')])(
		'rejects non-JSON extension data: %s',
		(value) => {
			expect(() => validatePodTemplate({ spec: { futureOption: value } })).toThrow(/futureOption/);
		},
	);

	it.each([
		{ labels: { 'invalid/key/format': 'value' } },
		{ labels: { team: 'contains spaces' } },
		{ labels: { ['a'.repeat(64)]: 'value' } },
		{ annotations: { 'invalid/key/format': 'value' } },
		{ annotations: { 'example.com/config': 'a'.repeat(256 * 1024) } },
	])('rejects invalid label or annotation syntax and size %#', (metadata) => {
		expect(() => validatePodTemplate({ metadata })).toThrow(/invalid|exceed/);
	});

	it('rejects ambiguous environment sources without including secret values in the error', () => {
		const input = withContainer({
			env: [
				{
					name: 'TOKEN',
					valueFrom: {
						secretKeyRef: { name: 'sensitive-secret-name', key: 'private-key' },
						configMapKeyRef: { name: 'config', key: 'token' },
					},
				},
			],
		});
		expect(() => validatePodTemplate(input)).toThrow(
			/^Invalid pod template at spec.containers.0.env.0.valueFrom \(custom\)$/,
		);
	});
});
