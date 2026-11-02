import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SidebarLink({
	label,
	to,
	icon: Icon,
	active,
	onNavigate,
}: {
	label: string;
	to: string;
	icon: LucideIcon;
	active: boolean;
	onNavigate?: () => void;
}) {
	return (
		<Link
			to={to}
			onClick={onNavigate}
			aria-current={active ? 'page' : undefined}
			className={cn(
				'flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none max-md:min-h-11',
				active
					? 'bg-primary/10 text-primary'
					: 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
			)}
		>
			<Icon className="size-4 shrink-0" aria-hidden />
			{label}
		</Link>
	);
}
