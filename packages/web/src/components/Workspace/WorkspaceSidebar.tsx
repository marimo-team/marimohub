import { searchPath } from '@/lib/workspaceSearch';
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
import { projectQueryOptions, useCapabilitiesQuery, useProjectsQuery } from '@/api/hooks';
import { useAuth } from '@/context/AuthContext';
import { ProjectPicker } from './ProjectPicker';
import { ProjectSettingsNavigation } from './ProjectSettingsNavigation';
import { SidebarLink } from './SidebarLink';
import { Button } from '@/components/ui';
import { canEditProject } from '@/lib/roles';
import { workspaceRoute } from './navigation';
import type { WorkspaceNavigationSlots } from './navigation';

export function WorkspaceSidebar({
	onNavigate,
	slots = {},
}: {
	onNavigate?: () => void;
	slots?: WorkspaceNavigationSlots;
}) {
	const { user } = useAuth();
	const location = useLocation();
	const enabled = Boolean(user && !user.app_only);
	const { pid, section } = workspaceRoute(location.pathname);
	const projects = useProjectsQuery({ status: 'active' }, { enabled, throwOnError: false });
	const selectedProject = useQuery({
		...projectQueryOptions(pid ?? ''),
		enabled: enabled && Boolean(pid),
		throwOnError: false,
	});
	const { data: capabilities } = useCapabilitiesQuery(enabled);
	if (!enabled) return null;
	const project = selectedProject.isError ? undefined : selectedProject.data;
	const canRead = Boolean(project?.your_role && project.your_role !== 'app-user');
	const projectPath = pid ? `/projects/${encodeURIComponent(pid)}` : '';
	const linkProps = { onNavigate };

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain p-3 text-sidebar-foreground">
			{slots.search?.available && slots.search.allowed ? (
				<SidebarLink
					{...linkProps}
					label="Search"
					shortcut={isAppleKeyboard() ? '⌘ K' : 'Ctrl K'}
					to={slots.search.to}
					icon={Search}
					active={location.pathname === slots.search.to.split('?')[0]}
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
				<nav aria-label="Project" className="space-y-1">
					{slots.search?.available && slots.search.allowed ? (
						<SidebarLink
							{...linkProps}
							label="Search project"
							to={searchPath(pid)}
							icon={Search}
							active={section === 'search'}
						/>
					) : null}
					{slots.chat?.available && slots.chat.allowed ? (
						<SidebarLink
							{...linkProps}
							label="Chat"
							to={slots.chat.to}
							icon={MessageSquare}
							active={section === 'chat'}
						/>
					) : null}
					<SidebarLink
						{...linkProps}
						label="Notebooks"
						to={projectPath}
						icon={Notebook}
						active={section === 'notebooks'}
					/>
					{capabilities?.data_browser?.available && canEditProject(project?.your_role ?? null) ? (
						<SidebarLink
							{...linkProps}
							label="Data"
							to={`${projectPath}/data`}
							icon={Database}
							active={section === 'data'}
						/>
					) : null}
					{capabilities?.jobs?.available ? (
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
			<nav aria-label="Browse" className="space-y-1 border-t border-sidebar-border pt-3">
				<SidebarLink
					{...linkProps}
					label="All projects"
					to="/projects"
					icon={ArrowLeft}
					active={location.pathname === '/' || location.pathname === '/projects'}
				/>
			</nav>
			{user?.is_super_admin ? (
				<nav aria-label="Administration" className="mt-auto border-t border-sidebar-border pt-3">
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
