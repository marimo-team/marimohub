import { useId, useState } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import { Button, Chip, RowLink } from '@/components/ui';
import { NotebookTags } from '@/components/Project/NotebookTags';
import { groupProjectsByTagPath } from '@/lib/projectGroups';
import type { ProjectSummary } from '@/types';

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

export function ProjectGroups({
	projects,
	groupByTags,
	prefix,
	onSelect,
}: {
	projects: ProjectSummary[];
	groupByTags: boolean;
	prefix?: string;
	onSelect: (prefix: string) => void;
}) {
	const { groups, direct, ungrouped } = groupProjectsByTagPath(projects, prefix);
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	const toggle = (key: string) =>
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	if (!groupByTags || groups.length === 0) {
		return projects.map((project) => <ProjectRow key={project.id} project={project} />);
	}
	return (
		<div className="flex flex-col divide-y">
			{direct.map((project) => (
				<ProjectRow key={project.id} project={project} />
			))}
			{groups.map((group) => (
				<ProjectSection
					key={group.prefix}
					label={group.label}
					projects={group.projects}
					collapsed={collapsed.has(group.prefix)}
					onToggle={() => toggle(group.prefix)}
					onSelect={() => onSelect(group.prefix)}
				/>
			))}
			{ungrouped.length > 0 && <ProjectSection label="Ungrouped" projects={ungrouped} />}
		</div>
	);
}

function ProjectSection({
	label,
	projects,
	collapsed = false,
	onToggle,
	onSelect,
}: {
	label: string;
	projects: ProjectSummary[];
	collapsed?: boolean;
	onToggle?: () => void;
	onSelect?: () => void;
}) {
	const id = useId();
	return (
		<section aria-labelledby={id}>
			<div className="flex items-center gap-1 px-3 py-1">
				{onToggle && (
					<Button
						variant="ghost"
						size="sm"
						className="size-7 p-0"
						aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
						aria-expanded={!collapsed}
						onPress={onToggle}
					>
						<ChevronRight aria-hidden="true" className={`size-4 ${collapsed ? '' : 'rotate-90'}`} />
					</Button>
				)}
				<h2 id={id} className="text-xs font-medium text-muted-foreground">
					{onSelect ? (
						<Button variant="ghost" size="sm" onPress={onSelect}>
							{label} · {projects.length}
						</Button>
					) : (
						`${label} · ${projects.length}`
					)}
				</h2>
			</div>
			{!collapsed && projects.map((project) => <ProjectRow key={project.id} project={project} />)}
		</section>
	);
}
