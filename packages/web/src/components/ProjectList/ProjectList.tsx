import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Folder } from 'lucide-react';
import {
	Button,
	SearchField,
	RowLink,
	EmptyState,
	ListContainer,
	PageContainer,
	PageHeader,
} from '@/components/ui';
import {
	FormDialog,
	optionalText,
	requiredText,
	schemaValidators,
	useAppForm,
	useSeedOnOpen,
} from '@/components/form';
import { useProjectsQuery, useCreateProject } from '@/api/hooks';
import { useDisclosure } from '@/hooks/useDisclosure';
import { useSearchHotkey } from '@/hooks/useSearchHotkey';
import { filterBySearch } from '@/lib/search';

const projectSchema = z.object({
	name: requiredText('Project name'),
	description: optionalText(),
});

const EMPTY_PROJECT = { name: '', description: '' };

export function ProjectList() {
	const [searchQuery, setSearchQuery] = useState('');
	const createModal = useDisclosure();
	const searchRef = useRef<HTMLInputElement>(null);
	useSearchHotkey(searchRef);

	const { data: projects } = useProjectsQuery();
	const createProject = useCreateProject();

	const createForm = useAppForm({
		defaultValues: EMPTY_PROJECT,
		validators: schemaValidators(projectSchema),
		onSubmit: async ({ value }) => {
			const name = value.name.trim();
			const description = value.description.trim();
			try {
				await createProject.mutateAsync({ name, description: description || name });
				toast.success(`Created project "${name}"`);
				createModal.close();
			} catch (err) {
				toast.error((err as Error).message);
			}
		},
	});
	useSeedOnOpen(createForm, createModal.isOpen, EMPTY_PROJECT);

	const filteredProjects = filterBySearch(
		projects,
		searchQuery,
		(p) => `${p.name} ${p.description}`,
	);

	return (
		<PageContainer>
			<PageHeader
				actions={
					<Button variant="primary" onPress={createModal.open}>
						+ New Project
					</Button>
				}
			>
				<h1 className="text-xl font-semibold tracking-tight">Projects</h1>
			</PageHeader>

			<div className="mb-4">
				<SearchField
					aria-label="Search projects"
					placeholder="Search projects..."
					value={searchQuery}
					onChange={setSearchQuery}
					inputRef={searchRef}
				/>
			</div>

			{filteredProjects.length === 0 ? (
				searchQuery ? (
					<EmptyState message={`No projects matching "${searchQuery}"`} />
				) : (
					<EmptyState
						message="No projects yet"
						action={
							<Button variant="ghost" onPress={createModal.open}>
								Create your first project
							</Button>
						}
					/>
				)
			) : (
				<ListContainer>
					{filteredProjects.map((project) => (
						<RowLink
							key={project.id}
							to={`/projects/${project.id}`}
							testId="project-row"
							contentClassName="flex-col gap-1"
						>
							<div className="flex items-center gap-2">
								<Folder className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
								<span className="text-sm font-medium">{project.name}</span>
								<span className="ml-auto text-xs text-muted-foreground">
									{project.notebook_count} notebook
									{project.notebook_count !== 1 ? 's' : ''}
								</span>
							</div>
							<div className="pl-6">
								<span className="truncate text-xs text-muted-foreground">
									{project.description}
								</span>
							</div>
						</RowLink>
					))}
				</ListContainer>
			)}

			<FormDialog
				form={createForm}
				isPending={createProject.isPending}
				isOpen={createModal.isOpen}
				onClose={createModal.close}
				title="Create New Project"
				submitLabel="Create"
				pendingLabel="Creating..."
			>
				<createForm.AppField name="name">
					{(f) => <f.TextField label="Project Name" placeholder="My Analysis" autoFocus />}
				</createForm.AppField>
				<createForm.AppField name="description">
					{(f) => <f.TextField label="Description" placeholder="Optional description" />}
				</createForm.AppField>
			</FormDialog>
		</PageContainer>
	);
}
