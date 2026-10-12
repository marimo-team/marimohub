import { childSegment, tagInNamespace } from '@marimo-hub/core/tag-paths';

export interface ProjectNamespace<P> {
	namespace: string;
	label: string;
	projects: P[];
}
export interface NamespacedProjects<P> {
	namespaces: ProjectNamespace<P>[];
	direct: P[];
	ungrouped: P[];
}

export function groupProjectsByNamespace<P extends { tags: string[] }>(
	projects: readonly P[],
	namespace?: string,
): NamespacedProjects<P> {
	const namespaces = new Map<string, ProjectNamespace<P>>();
	const direct: P[] = [];
	const ungrouped: P[] = [];
	for (const project of projects) {
		const segments = new Set<string>();
		let isDirect = false;
		for (const tag of project.tags) {
			if (namespace !== undefined && tag === namespace && tagInNamespace(tag, namespace))
				isDirect = true;
			const segment = childSegment(tag, namespace);
			if (segment !== undefined) segments.add(segment);
		}
		if (isDirect) direct.push(project);
		if (namespace === undefined && segments.size === 0) ungrouped.push(project);
		for (const label of segments) {
			const key = namespace === undefined ? label : `${namespace}/${label}`;
			let entry = namespaces.get(key);
			if (!entry) {
				entry = { namespace: key, label, projects: [] };
				namespaces.set(key, entry);
			}
			entry.projects.push(project);
		}
	}
	return {
		namespaces: [...namespaces.values()].sort((a, b) => a.namespace.localeCompare(b.namespace)),
		direct,
		ungrouped,
	};
}
