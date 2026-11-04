import { SEARCH_ROUTE, searchPath } from '@/lib/workspaceSearch';
import { isAppleKeyboard } from '@/lib/keyboard';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import {
	CalendarClock,
	ArrowLeft,
	Database,
	MessageSquare,
	Notebook,
	Search,
	Shield,
} from 'lucide-react';
import { projectQueryOptions, useProjectsQuery } from '@/api/hooks';
import { useSearchAccess } from '@/hooks/useSearchAccess';
import { ProjectPicker } from './ProjectPicker';
import { ProjectSharingIndicator } from './ProjectSharingIndicator';
import { ProjectSettingsNavigation } from './ProjectSettingsNavigation';
import { SidebarLink } from './SidebarLink';
import { Button } from '@/components/ui';
import { canEditProject, canReadProjectSource } from '@/lib/roles';
import { workspaceRoute } from './navigation';

export function WorkspaceSidebar({ onNavigate }: { onNavigate?: () => void }) {
	const { user, allowed: enabled, available: searchAvailable, capabilities } = useSearchAccess();
	const location = useLocation();
	const { pid, section } = workspaceRoute(location.pathname);
	const projects = useProjectsQuery({ status: 'active' }, { enabled, throwOnError: false });
	const selectedProject = useQuery({
		...projectQueryOptions(pid ?? ''),
		enabled: enabled && Boolean(pid),
		throwOnError: false,
	});
	if (!enabled) return null;
	const project = selectedProject.isError ? undefined : selectedProject.data;
	const canRead = canReadProjectSource(project?.your_role);
	const projectPath = pid ? `/projects/${encodeURIComponent(pid)}` : '';
	const linkProps = { onNavigate };

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-3 text-sidebar-foreground">
			{searchAvailable ? (
				<SidebarLink
					{...linkProps}
					label="Search"
					shortcut={isAppleKeyboard() ? '⌘ K' : 'Ctrl K'}
					to={SEARCH_ROUTE}
					icon={Search}
					active={location.pathname === SEARCH_ROUTE}
				/>
			) : null}
			<div className="space-y-2">
				<ProjectPicker
					projects={projects.data ?? []}
					selectedId={pid}
					selectedName={project?.name}
					isPending={projects.isPending}
					canCreate={user?.can_create_projects ?? false}
					onNavigate={onNavigate}
				/>
				{canRead && project ? (
					<ProjectSharingIndicator
						project={project}
						user={user}
						inheritedRole={capabilities.data?.default_role}
						onNavigate={onNavigate}
					/>
				) : null}
				{projects.isError ? (
					<div role="alert" className="px-2 text-xs text-muted-foreground">
						<p>Project list unavailable.</p>
						<Button size="sm" onPress={() => void projects.refetch()}>
							Retry projects
						</Button>
					</div>
				) : null}
			</div>
			{canRead ? (
				<nav aria-label="Project" className="space-y-0.5">
					{searchAvailable ? (
						<SidebarLink
							{...linkProps}
							label="Search project"
							to={searchPath(pid)}
							icon={Search}
							active={section === 'search'}
						/>
					) : null}
					<SidebarLink
						{...linkProps}
						label="Notebooks"
						to={projectPath}
						icon={Notebook}
						active={section === 'notebooks'}
					/>
					{capabilities.data?.chat?.available ? (
						<SidebarLink
							{...linkProps}
							label="Chat"
							to={`${projectPath}/chat`}
							icon={MessageSquare}
							active={section === 'chat'}
						/>
					) : null}
					{capabilities.data?.data_browser?.available &&
					canEditProject(project?.your_role ?? null) ? (
						<SidebarLink
							{...linkProps}
							label="Data"
							to={`${projectPath}/data`}
							icon={Database}
							active={section === 'data'}
						/>
					) : null}
					{capabilities.data?.jobs?.available ? (
						<SidebarLink
							{...linkProps}
							label="Jobs"
							to={`${projectPath}/jobs`}
							icon={CalendarClock}
							active={section === 'jobs'}
						/>
					) : null}
				</nav>
			) : null}
			{canRead && project ? (
				<ProjectSettingsNavigation
					key={project.id}
					project={project}
					section={section}
					onNavigate={onNavigate}
				/>
			) : null}
			<nav aria-label="Browse" className="space-y-0.5 border-t border-sidebar-border pt-2">
				<SidebarLink
					{...linkProps}
					label="All projects"
					to="/projects"
					icon={ArrowLeft}
					active={location.pathname === '/' || location.pathname === '/projects'}
				/>
			</nav>
			{user?.is_super_admin ? (
				<nav aria-label="Administration" className="mt-auto border-t border-sidebar-border pt-2">
					<SidebarLink
						{...linkProps}
						label="Admin"
						to="/admin/users"
						icon={Shield}
						active={location.pathname.startsWith('/admin/')}
					/>
				</nav>
			) : null}
		</div>
	);
}
