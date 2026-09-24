import { z } from 'zod';
import { ProjectId } from './ids';

const rule = z.strictObject({
	resource: z.string().trim().min(1),
	projects: z.union([z.literal('*'), z.array(z.string().refine(ProjectId.is)).min(1)]),
});

export type ProjectResourceRule = z.infer<typeof rule>;

export function parseProjectResourceRules(value: unknown): ProjectResourceRule[] {
	return z.array(rule).parse(value);
}

export function allowsProjectResource(
	rules: readonly ProjectResourceRule[],
	resource: string,
	projectId?: ProjectId,
): boolean {
	return rules.some(
		(rule) =>
			(rule.resource === '*' || rule.resource === resource) &&
			(rule.projects === '*' || (projectId !== undefined && rule.projects.includes(projectId))),
	);
}
