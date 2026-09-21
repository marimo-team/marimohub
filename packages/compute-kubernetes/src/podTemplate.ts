import { readFileSync } from 'node:fs';
import type {
	V1Container,
	V1ObjectMeta,
	V1PodSecurityContext,
	V1PodSpec,
} from '@kubernetes/client-node';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import {
	KERNEL_CONTAINER_NAME,
	MANAGED_BY_LABEL,
	SANDBOX_ID_ANNOTATION,
	SANDBOX_NAME_LABEL,
	validateIngressAnnotations,
	validateLabels,
} from './shared';

type ManagedContainerField = 'image' | 'command' | 'args' | 'ports' | 'resources';
type ManagedSpecField =
	| 'containers'
	| 'initContainers'
	| 'ephemeralContainers'
	| 'resources'
	| 'serviceAccount'
	| 'restartPolicy';

export interface KubernetesPodTemplate {
	apiVersion?: 'v1';
	kind?: 'Pod';
	metadata?: Pick<V1ObjectMeta, 'labels' | 'annotations'>;
	spec?: Omit<Partial<V1PodSpec>, ManagedSpecField | 'securityContext'> & {
		restartPolicy?: 'Never';
		securityContext?: Partial<V1PodSecurityContext>;
		containers?: (Omit<Partial<V1Container>, ManagedContainerField | 'name'> & {
			name: typeof KERNEL_CONTAINER_NAME;
		})[];
	};
}

const nonemptyString = z.string().min(1);
const dnsLabel = nonemptyString.max(63).regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/);
const dnsSubdomain = nonemptyString
	.max(253)
	.regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/);
const stringMap = z.record(z.string(), z.string());
const object = z.record(z.string(), z.json());
const nonnegativeInt = z.number().int().nonnegative();
const mode = nonnegativeInt.max(0o777);
const forbidden = z.never().optional();

function exactlyOneDefined(values: unknown[]): boolean {
	return values.filter((value) => value !== undefined).length === 1;
}

const securityContext = z.object({
	runAsUser: nonnegativeInt.optional(),
	runAsGroup: nonnegativeInt.optional(),
	runAsNonRoot: z.boolean().optional(),
	seccompProfile: z
		.discriminatedUnion('type', [
			z.object({ type: z.literal('RuntimeDefault') }).strict(),
			z.object({ type: z.literal('Unconfined') }).strict(),
			z
				.object({
					type: z.literal('Localhost'),
					localhostProfile: nonemptyString.refine(
						(path) => !path.startsWith('/') && !path.split('/').includes('..'),
						{ message: 'must be a relative path without backsteps' },
					),
				})
				.strict(),
		])
		.optional(),
});
const namedReference = z
	.object({ name: dnsSubdomain, optional: z.boolean().optional() })
	.catchall(z.json());
const keyReference = namedReference.extend({ key: nonemptyString });
const envVar = z
	.object({
		name: nonemptyString,
		value: z.string().optional(),
		valueFrom: z
			.object({
				secretKeyRef: keyReference.optional(),
				configMapKeyRef: keyReference.optional(),
				fieldRef: z
					.object({ fieldPath: nonemptyString, apiVersion: nonemptyString.optional() })
					.strict()
					.optional(),
				resourceFieldRef: z.object({ resource: nonemptyString }).catchall(z.json()).optional(),
			})
			.strict()
			.refine((value) => exactlyOneDefined(Object.values(value)), {
				message: 'valueFrom requires exactly one source',
			})
			.optional(),
	})
	.strict()
	.refine((v) => v.value === undefined || v.valueFrom === undefined, {
		message: 'value and valueFrom are mutually exclusive',
	});
const serviceAccountToken = z
	.object({
		audience: nonemptyString.optional(),
		expirationSeconds: z.number().int().min(600).optional(),
		path: nonemptyString,
	})
	.strict();
const projection = z
	.object({ serviceAccountToken: serviceAccountToken.optional() })
	.catchall(object)
	.refine((value) => exactlyOneDefined(Object.values(value)), {
		message: 'projection requires exactly one source',
	});
const volume = z
	.object({
		name: dnsLabel,
		projected: z
			.object({
				defaultMode: mode.optional(),
				sources: z.array(projection).min(1),
			})
			.strict()
			.optional(),
	})
	.catchall(object)
	.refine((v) => Object.keys(v).filter((key) => key !== 'name').length === 1, {
		message: 'volume requires exactly one source',
	});

const container = z
	.object({
		name: z.literal(KERNEL_CONTAINER_NAME),
		image: forbidden,
		command: forbidden,
		args: forbidden,
		ports: forbidden,
		resources: forbidden,
		imagePullPolicy: z.enum(['Always', 'IfNotPresent', 'Never']).optional(),
		env: z.array(envVar).optional(),
		envFrom: z
			.array(
				z
					.object({
						prefix: z.string().optional(),
						secretRef: namedReference.optional(),
						configMapRef: namedReference.optional(),
					})
					.strict()
					.refine((value) => exactlyOneDefined([value.secretRef, value.configMapRef]), {
						message: 'envFrom requires exactly one source',
					}),
			)
			.optional(),
		securityContext: securityContext
			.extend({
				allowPrivilegeEscalation: z.boolean().optional(),
				privileged: z.boolean().optional(),
				readOnlyRootFilesystem: z.boolean().optional(),
				capabilities: z
					.object({
						add: z.array(nonemptyString).optional(),
						drop: z.array(nonemptyString).optional(),
					})
					.strict()
					.optional(),
			})
			.catchall(z.json())
			.optional(),
		volumeMounts: z
			.array(
				z
					.object({
						name: dnsLabel,
						mountPath: nonemptyString,
						readOnly: z.boolean().optional(),
						subPath: z.string().optional(),
						subPathExpr: z.string().optional(),
					})
					.catchall(z.json()),
			)
			.optional(),
	})
	.catchall(z.json());

const templateSchema = z
	.object({
		apiVersion: z.literal('v1').optional(),
		kind: z.literal('Pod').optional(),
		metadata: z
			.object({ labels: stringMap.optional(), annotations: stringMap.optional() })
			.strict()
			.optional(),
		spec: z
			.object({
				containers: z.array(container).length(1).optional(),
				initContainers: forbidden,
				ephemeralContainers: forbidden,
				resources: forbidden,
				restartPolicy: z.literal('Never').optional(),
				serviceAccountName: dnsSubdomain.optional(),
				serviceAccount: forbidden,
				automountServiceAccountToken: z.boolean().optional(),
				enableServiceLinks: z.boolean().optional(),
				terminationGracePeriodSeconds: nonnegativeInt.optional(),
				imagePullSecrets: z.array(namedReference).optional(),
				securityContext: securityContext
					.extend({
						fsGroup: nonnegativeInt.optional(),
						supplementalGroups: z.array(nonnegativeInt).optional(),
					})
					.catchall(z.json())
					.optional(),
				volumes: z.array(volume).optional(),
				nodeSelector: stringMap.optional(),
				affinity: object.optional(),
				tolerations: z.array(object).optional(),
				topologySpreadConstraints: z.array(object).optional(),
				runtimeClassName: dnsSubdomain.optional(),
				dnsPolicy: nonemptyString.optional(),
				dnsConfig: object.optional(),
				hostNetwork: z.boolean().optional(),
				hostPID: z.boolean().optional(),
				hostIPC: z.boolean().optional(),
			})
			.catchall(z.json())
			.optional(),
	})
	.strict();

function assertUnique(values: string[], path: string): void {
	if (new Set(values).size !== values.length) throw new Error(`${path} contains duplicate entries`);
}

export function validatePodTemplate(value: unknown): KubernetesPodTemplate {
	const result = templateSchema.safeParse(value);
	if (!result.success) {
		// Report paths, not values: env entries may contain credentials.
		const issue = result.error.issues[0];
		const detail =
			issue?.code === 'invalid_type' && issue.expected === 'never'
				? 'field is managed by MarimoHub or unsupported in templates; omit it'
				: issue?.code;
		throw new Error(`Invalid pod template at ${issue?.path.join('.') || '<root>'} (${detail})`);
	}
	const template = result.data;
	const labels = template.metadata?.labels ?? {};
	validateLabels(labels);
	validateIngressAnnotations(template.metadata?.annotations);
	if (MANAGED_BY_LABEL in labels || SANDBOX_NAME_LABEL in labels) {
		throw new Error('Pod template labels must not set MarimoHub management or selector labels');
	}
	if (SANDBOX_ID_ANNOTATION in (template.metadata?.annotations ?? {})) {
		throw new Error('Pod template annotations must not set the MarimoHub sandbox identity');
	}
	const spec = template.spec;
	const kernel = spec?.containers?.[0];
	const volumes = spec?.volumes ?? [];
	assertUnique(
		volumes.map((v) => v.name),
		'spec.volumes',
	);
	assertUnique(
		(kernel?.env ?? []).map((v) => v.name),
		'spec.containers.marimo.env',
	);
	assertUnique(
		(kernel?.volumeMounts ?? []).map((v) => v.mountPath),
		'spec.containers.marimo.volumeMounts',
	);
	assertUnique(
		(spec?.imagePullSecrets ?? []).map((v) => v.name),
		'spec.imagePullSecrets',
	);
	for (const mount of kernel?.volumeMounts ?? []) {
		if (!volumes.some((v) => v.name === mount.name)) {
			throw new Error('Pod template volumeMounts must reference a volume in spec.volumes');
		}
	}
	return template as KubernetesPodTemplate;
}

export function parsePodTemplate(source: string): KubernetesPodTemplate {
	// Kubernetes manifests use YAML 1.1 octal modes, such as defaultMode: 0444.
	const document = parseDocument(source, { version: '1.1', prettyErrors: false });
	if (document.errors.length > 0 || document.warnings.length > 0) {
		throw new Error('Pod template must contain one valid YAML or JSON document');
	}
	let value: unknown;
	try {
		value = document.toJS({ maxAliasCount: 100 });
		JSON.stringify(value); // Reject cyclic YAML aliases before schema traversal.
	} catch {
		throw new Error('Pod template contains unresolved, cyclic, or excessive YAML aliases');
	}
	return validatePodTemplate(value);
}

export function loadPodTemplateFile(path: string): KubernetesPodTemplate {
	let source: string;
	try {
		source = readFileSync(path, 'utf8');
	} catch {
		throw new Error('Cannot read pod template file; mount a readable YAML or JSON file');
	}
	return parsePodTemplate(source);
}
