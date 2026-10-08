import { childSegment, tagMatchesPrefix } from '@marimo-hub/core/tag-paths';

export interface ProjectGroup<P> {
	prefix: string;
	label: string;
	projects: P[];
}
export interface GroupedProjects<P> {
	groups: ProjectGroup<P>[];
	direct: P[];
	ungrouped: P[];
}

export function groupProjectsByTagPath<P extends { tags: string[] }>(
	projects: readonly P[],
	prefix?: string,
): GroupedProjects<P> {
	const groups = new Map<string, ProjectGroup<P>>();
	const direct: P[] = [];
	const ungrouped: P[] = [];
	for (const project of projects) {
		const segments = new Set<string>();
		let isDirect = false;
		for (const tag of project.tags) {
			if (prefix !== undefined && tag === prefix && tagMatchesPrefix(tag, prefix)) isDirect = true;
			const segment = childSegment(tag, prefix);
			if (segment !== undefined) segments.add(segment);
		}
		if (isDirect) direct.push(project);
		if (prefix === undefined && segments.size === 0) ungrouped.push(project);
		for (const label of segments) {
			const key = prefix === undefined ? label : `${prefix}/${label}`;
			let group = groups.get(key);
			if (!group) {
				group = { prefix: key, label, projects: [] };
				groups.set(key, group);
			}
			group.projects.push(project);
		}
	}
	return {
		groups: [...groups.values()].sort((a, b) => a.prefix.localeCompare(b.prefix)),
		direct,
		ungrouped,
	};
}
