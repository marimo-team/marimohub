import { ProjectId } from '@marimo-hub/core';

export interface KubernetesSecretPolicy {
	namespace: string;
	name: string;
	projects: '*' | readonly ProjectId[];
}

export function parseKubernetesSecretPolicies(value: unknown): KubernetesSecretPolicy[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error('Kubernetes Secret policy must be a non-empty JSON array.');
	}

	const seenSecrets = new Set<string>();
	return value.map((candidate, index) => {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
			throw invalidRule(index, 'must be an object');
		}
		const rule = candidate as Record<string, unknown>;
		if (Object.keys(rule).some((key) => !['namespace', 'name', 'projects'].includes(key))) {
			throw invalidRule(index, 'contains an unknown field');
		}
		if (!isValidKubernetesNamespace(rule.namespace)) {
			throw invalidRule(index, 'has an invalid namespace');
		}
		if (!isValidKubernetesSecretName(rule.name)) {
			throw invalidRule(index, 'has an invalid Secret name');
		}
		const key = `${rule.namespace}\0${rule.name}`;
		if (seenSecrets.has(key)) {
			throw invalidRule(index, 'duplicates an earlier Secret');
		}
		seenSecrets.add(key);

		const projects = parseProjects(rule.projects, index);
		return { namespace: rule.namespace, name: rule.name, projects };
	});
}

export function isValidKubernetesNamespace(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 63 &&
		/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)
	);
}

export function isValidKubernetesSecretName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 253 &&
		value.split('.').every(isValidKubernetesNamespace)
	);
}

function parseProjects(value: unknown, index: number): '*' | ProjectId[] {
	if (value === '*') return '*';
	if (!Array.isArray(value) || value.length === 0) {
		throw invalidRule(index, 'projects must be "*" or a non-empty project ID array');
	}
	const projects = new Set<ProjectId>();
	for (const project of value) {
		if (!ProjectId.is(project)) {
			throw invalidRule(index, 'projects contains an invalid project ID');
		}
		if (projects.has(project)) {
			throw invalidRule(index, 'projects contains a duplicate project ID');
		}
		projects.add(project);
	}
	return [...projects];
}

function invalidRule(index: number, message: string): Error {
	return new Error(`Kubernetes Secret policy rule ${index + 1} ${message}.`);
}
