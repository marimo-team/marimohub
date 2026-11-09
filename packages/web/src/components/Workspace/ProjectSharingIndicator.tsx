import { Lock, LockOpen, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Tooltip } from '@/components/ui/Tooltip';
import { defaultAccessSummary, roleLabel } from '@/lib/roles';
import type { Capabilities, ProjectDetail, User } from '@/types';

export function ProjectSharingIndicator({
	project,
	user,
	inheritedRole,
	onNavigate,
}: {
	project: ProjectDetail;
	user: User | null;
	inheritedRole: Capabilities['default_role'] | undefined;
	onNavigate?: () => void;
}) {
	const role = project.default_role;
	const isPrivate =
		role === 'none' &&
		project.owner === user?.id &&
		project.members.every((member) => member.user_id === project.owner);
	const Icon = role === 'none' ? Lock : role === 'inherit' ? Users : LockOpen;
	const label = isPrivate
		? 'Private'
		: role === 'none'
			? 'Members only'
			: role === 'inherit'
				? 'Default sharing'
				: `Signed-in users · ${roleLabel(role)}`;
	const summary = isPrivate
		? 'This project is private to you. Deployment super admins retain access.'
		: (defaultAccessSummary(role, inheritedRole) ?? 'Deployment and sign-in defaults apply.');

	return (
		<Tooltip content={summary} placement="right">
			<Link
				to={`/projects/${encodeURIComponent(project.id)}/members`}
				onClick={onNavigate}
				aria-label={`Project sharing: ${label}`}
				className="flex min-h-8 items-center gap-2 rounded-md px-2.5 py-1 text-xs text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
			>
				<Icon className="size-3.5 shrink-0" aria-hidden />
				<span>{label}</span>
			</Link>
		</Tooltip>
	);
}
