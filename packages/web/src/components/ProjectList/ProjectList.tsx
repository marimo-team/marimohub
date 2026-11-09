import { useState } from 'react';
import { isPathTag } from '@marimo-hub/core/tag-paths';
import { ProjectNamespaces } from './ProjectNamespaces';
import { FolderPlus, Plus } from 'lucide-react';
import { Button, EmptyState, ListFilters, ListResults, Page } from '@/components/ui';
import { CreateProjectDialog } from './CreateProjectDialog';
import { useProjectsQuery, useProjectRoster } from '@/api/hooks';
import { useDisclosure } from '@/hooks/useDisclosure';
import { useListFilters } from '@/hooks/useListFilters';
import { useAuth } from '@/context/AuthContext';

const PROJECT_STATUS_FILTERS = [
	{ value: 'active', label: 'Active' },
	{ value: 'deleted', label: 'Deleted' },
] as const;

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
	// Include filtered results because the active roster omits deleted projects.
	const { data: roster = [] } = useProjectRoster({ throwOnError: false });
	const hasNamespaces = [...roster, ...projects].some((project) => project.tags.some(isPathTag));

	return (
		<Page
			width="wide"
			title="Projects"
			subtitle="Shared workspaces for your notebooks"
			actions={
				canCreateProjects ? (
					<Button variant="primary" onPress={createModal.open}>
						<Plus className="size-4" />
						New Project
					</Button>
				) : null
			}
		>
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
				<CreateProjectDialog isOpen={createModal.isOpen} onClose={createModal.close} />
			) : null}
		</Page>
	);
}
