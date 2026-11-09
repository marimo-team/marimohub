import { lazyRoute } from '@/lib/lazyRoute';

export const ProjectRoute = lazyRoute(async () => {
	const module = await import('./Project');
	return { default: module.Project };
});
