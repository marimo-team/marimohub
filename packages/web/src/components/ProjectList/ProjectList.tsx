import { toast } from 'sonner';
import { z } from 'zod';
import { ChevronRight, Folder, FolderPlus, Plus, SearchX } from 'lucide-react';
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
import { useSearchField } from '@/hooks/useSearchField';
import { toastError } from '@/lib/errors';
import { filterBySearch } from '@/lib/search';

const projectSchema = z.object({
	name: requiredText('Project name'),
	description: optionalText(),
});

const EMPTY_PROJECT = { name: '', description: '' };

export function ProjectList() {
	const search = useSearchField();
	const createModal = useDisclosure();

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
				toastError(err);
			}
		},
	});
	useSeedOnOpen(createForm, createModal.isOpen, EMPTY_PROJECT);

	const filteredProjects = filterBySearch(
		projects,
		search.query,
		(p) => `${p.name} ${p.description}`,
	);

	return (
		<PageContainer>
			<title>Projects · marimohub</title>
			<PageHeader
				actions={
					<Button variant="primary" onPress={createModal.open}>
						<Plus className="size-4" />
						New Project
					</Button>
				}
			>
				<div className="flex min-w-0 flex-col gap-0.5">
					<h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
					<p className="text-sm text-muted-foreground">
						{projects.length} project{projects.length !== 1 ? 's' : ''} · shared workspaces for your
						notebooks
					</p>
				</div>
			</PageHeader>

			<div className="mb-4">
				<SearchField
					aria-label="Search projects"
					placeholder="Search projects..."
					value={search.query}
					onChange={search.setQuery}
					inputRef={search.inputRef}
				/>
			</div>

			{filteredProjects.length === 0 ? (
				search.query ? (
					<EmptyState
						icon={<SearchX />}
						message={`No projects matching "${search.query}"`}
						description="Try a different search term."
					/>
				) : (
					<EmptyState
						icon={<FolderPlus />}
						message="No projects yet"
						description="Projects group related notebooks and their collaborators."
						action={
							<Button variant="default" onPress={createModal.open}>
								<Plus className="size-4" />
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
							contentClassName="items-center gap-3 py-3.5"
						>
							<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
								<Folder className="size-4" />
							</span>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="truncate text-sm font-medium">{project.name}</span>
								<span className="truncate text-xs text-muted-foreground">
									{project.description}
								</span>
							</span>
							<span className="shrink-0 rounded-full border bg-muted/60 px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
								{project.notebook_count} notebook
								{project.notebook_count !== 1 ? 's' : ''}
							</span>
							<ChevronRight className="size-4 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
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
