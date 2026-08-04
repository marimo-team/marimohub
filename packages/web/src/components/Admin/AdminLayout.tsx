import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';

const TABS = [
	{ to: '/admin/users', label: 'Users' },
	{ to: '/admin/settings', label: 'Settings' },
	{ to: '/admin/audit-logs', label: 'Audit logs' },
];

/** Super-admin gate + tab bar shared by every `/admin/*` page. */
export function AdminLayout() {
	const { user } = useAuth();
	if (!user?.is_super_admin) return <Navigate to="/" replace />;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<nav
				aria-label="Admin"
				className="flex shrink-0 gap-1 border-b bg-background px-6 pt-2 max-md:px-3"
			>
				{TABS.map((tab) => (
					<NavLink
						key={tab.to}
						to={tab.to}
						className={({ isActive }) =>
							cn(
								'-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
								isActive
									? 'border-primary text-foreground'
									: 'border-transparent text-muted-foreground hover:text-foreground',
							)
						}
					>
						{tab.label}
					</NavLink>
				))}
			</nav>
			<div className="flex min-h-0 flex-1 overflow-hidden">
				<Outlet />
			</div>
		</div>
	);
}
