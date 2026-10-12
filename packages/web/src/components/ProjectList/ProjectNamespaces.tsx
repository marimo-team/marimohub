import { useId, useState } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import { Button, Chip, RowLink } from '@/components/ui';
import { NotebookTags } from '@/components/Project/NotebookTags';
import { groupProjectsByNamespace } from '@/lib/projectNamespaces';
import { cn } from '@/lib/utils';
import type { ProjectSummary } from '@/types';

const NAMESPACE_PREVIEW_LIMIT = 5;
const UNGROUPED_SECTION = Symbol('ungrouped');

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
		</>
	);

	const metadata = (
		<>
			<NotebookTags tags={project.tags} title={project.name} />
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
				{metadata}
			</div>
		);
	}

	return (
		<RowLink
			to={`/projects/${project.id}`}
			testId="project-row"
			trailing={metadata}
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

function ProjectRows({ projects }: { projects: ProjectSummary[] }) {
	return projects.map((project) => <ProjectRow key={project.id} project={project} />);
}

export function ProjectNamespaces({
	projects,
	groupByNamespace,
	namespace,
	onSelect,
}: {
	projects: ProjectSummary[];
	groupByNamespace: boolean;
	namespace?: string;
	onSelect: (namespace: string) => void;
}) {
	const { namespaces, direct, ungrouped } = groupProjectsByNamespace(projects, namespace);
	const [collapsed, setCollapsed] = useState<Set<string | symbol>>(() => new Set());
	const toggle = (key: string | symbol) =>
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	if (!groupByNamespace || namespaces.length === 0) {
		return <ProjectRows projects={projects} />;
	}
	return (
		<div className="flex flex-col divide-y">
			{/* Rows drop their own border-b when last, so divide-y adds the only separator. */}
			{direct.length > 0 && (
				<div>
					<ProjectRows projects={direct} />
				</div>
			)}
			{namespaces.map((entry) => (
				<NamespaceSection
					key={entry.namespace}
					label={entry.label}
					projects={entry.projects}
					collapsed={collapsed.has(entry.namespace)}
					onToggle={() => toggle(entry.namespace)}
					onSelect={() => onSelect(entry.namespace)}
				/>
			))}
			{ungrouped.length > 0 && (
				<NamespaceSection
					label="Ungrouped"
					projects={ungrouped}
					collapsed={collapsed.has(UNGROUPED_SECTION)}
					onToggle={() => toggle(UNGROUPED_SECTION)}
				/>
			)}
		</div>
	);
}

function NamespaceSection({
	label,
	projects,
	collapsed,
	onToggle,
	onSelect,
}: {
	label: string;
	projects: ProjectSummary[];
	collapsed: boolean;
	onToggle: () => void;
	onSelect?: () => void;
}) {
	const headingId = useId();
	const contentId = useId();
	const visibleProjects = onSelect ? projects.slice(0, NAMESPACE_PREVIEW_LIMIT) : projects;
	return (
		<section aria-labelledby={headingId}>
			<div className="flex items-center gap-1 px-3 py-1">
				<Button
					variant="ghost"
					size="sm"
					className="size-7 p-0"
					aria-label={`Toggle ${label}`}
					aria-expanded={!collapsed}
					aria-controls={contentId}
					onPress={onToggle}
				>
					<ChevronRight
						aria-hidden="true"
						className={cn('size-4 transition-transform', !collapsed && 'rotate-90')}
					/>
				</Button>
				<h2
					id={headingId}
					className="min-w-0 text-xs font-medium text-muted-foreground wrap-anywhere"
				>
					{onSelect ? (
						<Button variant="ghost" size="sm" onPress={onSelect}>
							{label} · {projects.length}
						</Button>
					) : (
						`${label} · ${projects.length}`
					)}
				</h2>
			</div>
			<div id={contentId}>
				{!collapsed && (
					<>
						<ProjectRows projects={visibleProjects} />
						{onSelect && projects.length > NAMESPACE_PREVIEW_LIMIT && (
							<div className="px-4 py-2">
								<Button variant="ghost" size="sm" onPress={onSelect}>
									Show all {projects.length}
									<ChevronRight className="size-4" aria-hidden="true" />
								</Button>
							</div>
						)}
					</>
				)}
			</div>
		</section>
	);
}
