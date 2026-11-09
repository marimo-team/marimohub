import { lazyDialog } from '@/components/ui/lazyDialog';

export const CreateProjectDialog = lazyDialog(async () => {
	const module = await import('./CreateProjectForm');
	return { default: module.CreateProjectForm };
});
