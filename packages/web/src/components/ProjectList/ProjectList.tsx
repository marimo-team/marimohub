import { toast } from 'sonner';
import { z } from 'zod';
import { ChevronRight, Folder, FolderPlus, Plus } from 'lucide-react';
import {
	Button,
	Chip,
	RowLink,
	EmptyState,
	ListFilters,
	ListResults,
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
import { useListFilters } from '@/hooks/useListFilters';
import { useAuth } from '@/context/AuthContext';
import type { ProjectSummary } from '@/types';

const PROJECT_STATUS_FILTERS = [
	{ value: 'active', label: 'Active' },
	{ value: 'deleted', label: 'Deleted' },
] as const;

const projectSchema = z.object({
	name: requiredText('Project name'),
	description: optionalText(),
});

const EMPTY_PROJECT = { name: '', description: '' };

export function ProjectList() {
	const { user } = useAuth();
	const canCreateProjects = user?.can_create_projects ?? user !== null;
	const { filters, setFilters, filtersActive } = useListFilters(PROJECT_STATUS_FILTERS);
	const createModal = useDisclosure();

	const { data: projects = [], isPending, isFetching } = useProjectsQuery(filters);
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
			} catch {
				return;
			}
		},
	});
	useSeedOnOpen(createForm, createModal.isOpen, EMPTY_PROJECT);

	return (
		<PageContainer>
			<title>Projects · marimohub</title>
			<PageHeader
				actions={
					canCreateProjects ? (
						<Button variant="primary" onPress={createModal.open}>
							<Plus className="size-4" />
							New Project
						</Button>
					) : null
				}
			>
				<div className="flex min-w-0 flex-col gap-0.5">
					<h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
					<p className="text-sm text-muted-foreground">Shared workspaces for your notebooks</p>
				</div>
			</PageHeader>

			<ListFilters
				label="Filter projects"
				itemName="project"
				values={filters}
				statuses={PROJECT_STATUS_FILTERS}
				resultCount={projects.length}
				resultsId="project-results"
				isLoading={isPending}
				isFetching={isFetching}
				onChange={setFilters}
			/>

			<ListResults
				count={projects.length}
				emptyState={
					<EmptyState
						icon={<FolderPlus />}
						message="No projects yet"
						description="Projects group related notebooks and their collaborators."
						action={
							canCreateProjects ? (
								<Button variant="default" onPress={createModal.open}>
									<Plus className="size-4" />
									Create your first project
								</Button>
							) : null
						}
					/>
				}
				isFetching={isFetching}
				isFiltered={filtersActive}
				isLoading={isPending}
				itemName="project"
				onReset={() => setFilters({})}
				resultsId="project-results"
			>
				{projects.map((project) => (
					<ProjectRow key={project.id} project={project} />
				))}
			</ListResults>

			{canCreateProjects ? (
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
			) : null}
		</PageContainer>
	);
}

function ProjectRow({ project }: { project: ProjectSummary }) {
	const content = (
		<>
			<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
				<Folder className="size-4" aria-hidden="true" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-sm font-medium" title={project.name}>
					{project.name}
				</span>
				<span className="truncate text-xs text-muted-foreground" title={project.description}>
					{project.description}
				</span>
			</span>
			{project.status === 'deleted' ? <Chip>Deleted</Chip> : null}
			<span className="shrink-0 rounded-full border bg-muted/60 px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
				{project.notebook_count} notebook{project.notebook_count !== 1 ? 's' : ''}
			</span>
		</>
	);

	if (project.status === 'deleted') {
		return (
			<div
				data-testid="project-row"
				className="flex items-center gap-3 border-b border-l-2 border-l-transparent bg-muted/20 px-4 py-3.5 last:border-b-0"
			>
				{content}
			</div>
		);
	}

	return (
		<RowLink
			to={`/projects/${project.id}`}
			testId="project-row"
			contentClassName="items-center gap-3 py-3.5"
		>
			{content}
			<ChevronRight
				className="size-4 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground"
				aria-hidden="true"
			/>
		</RowLink>
	);
}
