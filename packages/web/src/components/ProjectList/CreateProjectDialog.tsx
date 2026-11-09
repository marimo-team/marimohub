import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

const CreateProjectForm = lazy(() =>
	import('./CreateProjectForm').then((module) => ({ default: module.CreateProjectForm })),
);

export function CreateProjectDialog(props: ComponentProps<typeof CreateProjectForm>) {
	return props.isOpen ? (
		<Suspense fallback={null}>
			<CreateProjectForm {...props} />
		</Suspense>
	) : null;
}
