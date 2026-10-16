import { useState } from 'react';
import { isPathTag } from '@marimo-hub/core/tag-paths';
import { ProjectNamespaces } from './ProjectNamespaces';
import { PageTitle } from '@/components/ui/PageTitle';
import { toast } from 'sonner';
import { z } from 'zod';
import { FolderPlus, Plus } from 'lucide-react';
import {
	Button,
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

const PROJECT_STATUS_FILTERS = [
	{ value: 'active', label: 'Active' },
	{ value: 'deleted', label: 'Deleted' },
] as const;

const projectSchema = z.object({
	name: requiredText('Project name'),
	description: optionalText(),
});

const EMPTY_PROJECT = { name: '', description: '' };

// Predates the namespace rename; kept so saved preferences survive.
const GROUP_BY_NAMESPACE_KEY = 'project-group-by-tags';

export function ProjectList() {
	const { user } = useAuth();
	const canCreateProjects = user?.can_create_projects ?? user !== null;
	const { filters, setFilters, filtersActive } = useListFilters(PROJECT_STATUS_FILTERS, {
		tagNamespace: true,
	});
	const selectNamespace = (tag_namespace?: string) => setFilters({ ...filters, tag_namespace });
	const createModal = useDisclosure();
	const [groupByNamespace, setGroupByNamespace] = useState(() => {
		try {
			return localStorage.getItem(GROUP_BY_NAMESPACE_KEY) !== 'false';
		} catch {
			return true;
		}
	});

	const { data: projects = [], isPending, isFetching } = useProjectsQuery(filters);
	// Read namespaces from the unfiltered roster so the toggle does not flicker as filters
	// narrow the results; with no filters this shares the query above. The roster omits
	// deleted projects, so the displayed results count too.
	const { data: roster = [] } = useProjectsQuery({}, { throwOnError: false });
	const hasNamespaces = [...roster, ...projects].some((project) => project.tags.some(isPathTag));
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
			<PageTitle>Projects</PageTitle>
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
				actions={
					hasNamespaces ? (
						<Button
							size="sm"
							variant={groupByNamespace ? 'default' : 'ghost'}
							aria-pressed={groupByNamespace}
							onPress={() => {
								setGroupByNamespace(!groupByNamespace);
								try {
									localStorage.setItem(GROUP_BY_NAMESPACE_KEY, String(!groupByNamespace));
								} catch {}
							}}
						>
							Group by namespace
						</Button>
					) : null
				}
			/>

			{filters.tag_namespace !== undefined && (
				<nav aria-label="Project namespace" className="flex flex-wrap items-center gap-1 text-sm">
					<Button variant="ghost" onPress={() => selectNamespace()}>
						All projects
					</Button>
					{filters.tag_namespace.split('/').map((segment, index, segments) => (
						<span key={segments.slice(0, index + 1).join('/')} className="flex items-center gap-1">
							<span aria-hidden="true">/</span>
							<Button
								variant="ghost"
								aria-current={index === segments.length - 1 ? 'page' : undefined}
								onPress={() => selectNamespace(segments.slice(0, index + 1).join('/'))}
							>
								{segment}
							</Button>
						</span>
					))}
				</nav>
			)}

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
				<ProjectNamespaces
					projects={projects}
					groupByNamespace={groupByNamespace}
					namespace={filters.tag_namespace}
					onSelect={selectNamespace}
				/>
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
