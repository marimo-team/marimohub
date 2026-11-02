import { HelpMenu } from './HelpMenu';
import { shellLinkTarget, useShellLinks } from '@/components/Shell/useShellLinks';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useBranding } from '@/context/BrandingContext';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { MenuTrigger, Button, Popover, Menu, MenuItem, Separator } from 'react-aria-components';
import { ChevronDown, Copy, KeyRound, Moon, Plug, Puzzle, Shield, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { Brand, UserAvatar } from '@/components/ui';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useDisclosure } from '@/hooks/useDisclosure';
import { useCapabilitiesQuery } from '@/api/hooks';
import { McpDialog } from '@/components/Account/McpDialog';
import { ApiTokensDialog } from '@/components/Account/ApiTokensDialog';
import { OrgIntegrationsDialog } from '@/components/Project/ProjectIntegrationsDialog';

export function Header({ navigationTrigger }: { navigationTrigger?: ReactNode }) {
	const { name } = useBranding();
	const links = useShellLinks('header');
	const navigate = useNavigate();
	const { user, signOut } = useAuth();
	const { theme, isThemeForced, toggleTheme } = useTheme();
	const tokensDialog = useDisclosure();
	const mcpDialog = useDisclosure();
	const { data: capabilities } = useCapabilitiesQuery(!!user);
	const orgIntegrationsDialog = useDisclosure();
	const { copy } = useCopyToClipboard();

	return (
		<header className="sticky top-0 z-40 flex min-h-14 shrink-0 flex-wrap gap-2 py-2 items-center justify-between border-b bg-background/85 px-4 backdrop-blur-md max-md:px-3">
			{navigationTrigger}
			<Link
				to={user?.app_only ? '/apps' : '/'}
				aria-label={`${name} home`}
				className="max-md:mr-auto rounded-lg outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
			>
				<Brand builtInWordmarkClassName="max-md:hidden" />
			</Link>

			<nav
				aria-label="Global"
				className="ml-6 flex min-w-0 flex-wrap items-center gap-1 max-md:order-last max-md:ml-0 max-md:w-full"
			>
				{!user?.app_only || user.can_create_projects ? (
					<NavLink
						to="/projects"
						className={({ isActive }) =>
							cn(
								'flex min-h-11 items-center rounded-md px-3 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:px-2',
								isActive ? 'bg-accent text-foreground' : 'text-muted-foreground',
							)
						}
					>
						Projects
					</NavLink>
				) : null}
				<NavLink
					to="/apps"
					className={({ isActive }) =>
						cn(
							'flex min-h-11 items-center rounded-md px-3 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:px-2',
							isActive ? 'bg-accent text-foreground' : 'text-muted-foreground',
						)
					}
				>
					Apps
				</NavLink>
				{links.map((link) => (
					<a
						key={link.id}
						href={link.href}
						target={shellLinkTarget(link)}
						rel="noopener noreferrer"
						className="px-3 py-2 text-sm max-md:px-2"
					>
						{link.label}
					</a>
				))}
			</nav>
			<div className="ml-auto flex items-center gap-2 max-md:gap-1">
				<HelpMenu />
				{!isThemeForced && (
					<Button
						onPress={toggleTheme}
						aria-label="Toggle theme"
						className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						{theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
					</Button>
				)}

				{user ? (
					<MenuTrigger>
						<Button
							aria-label="User menu"
							className="flex items-center gap-1.5 rounded-full border border-input bg-card p-1 pr-2.5 shadow-xs transition-[border-color,box-shadow] hover:border-ring hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:min-h-11"
						>
							<UserAvatar
								pictureUrl={user.picture_url}
								label={user.name ?? user.email}
								className="size-6 text-[11px]"
							/>
							<ChevronDown className="size-3 text-muted-foreground" />
						</Button>
						<Popover
							placement="bottom end"
							className="scrollable-overlay z-50 min-w-[180px] rounded-md border bg-popover text-popover-foreground shadow-lg entering:animate-in entering:fade-in-0 entering:zoom-in-95 exiting:animate-out exiting:fade-out-0 exiting:zoom-out-95"
						>
							<Menu
								className="outline-none"
								onAction={(key) => {
									if (key === 'signout') signOut();
									else if (key === 'copy-id') {
										void copy(user.id).then((ok) => ok && toast.success('User id copied'));
									} else if (key === 'api-tokens') tokensDialog.open();
									else if (key === 'mcp') mcpDialog.open();
									else if (key === 'org-integrations') orgIntegrationsDialog.open();
									else if (key === 'admin') void navigate('/admin/users');
								}}
							>
								<MenuItem
									id="email"
									isDisabled
									className="block border-b bg-muted px-3 py-3 text-xs text-muted-foreground"
								>
									<span className="block truncate">{user.email}</span>
									{/* Shown so members can share their id — project invites are by user id. */}
									<span className="block truncate font-mono text-[11px] text-muted-foreground/70">
										{user.id}
									</span>
								</MenuItem>
								<MenuItem
									id="copy-id"
									className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] outline-none transition-colors focus:bg-muted max-md:min-h-11"
								>
									<Copy className="size-3.5" />
									Copy user id
								</MenuItem>
								{!user.app_only && (
									<MenuItem
										id="api-tokens"
										className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] outline-none transition-colors focus:bg-muted max-md:min-h-11"
									>
										<KeyRound className="size-3.5" />
										API tokens
									</MenuItem>
								)}
								{!user.app_only && capabilities?.mcp?.available && capabilities.mcp.url ? (
									<MenuItem
										id="mcp"
										className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] outline-none transition-colors focus:bg-muted max-md:min-h-11"
									>
										<Plug className="size-3.5" />
										MCP
									</MenuItem>
								) : null}
								{user.is_super_admin && (
									<MenuItem
										id="org-integrations"
										className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] outline-none transition-colors focus:bg-muted max-md:min-h-11"
									>
										<Puzzle className="size-3.5" />
										Org integrations
									</MenuItem>
								)}
								{user.is_super_admin && (
									<MenuItem
										id="admin"
										className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] outline-none transition-colors focus:bg-muted max-md:min-h-11"
									>
										<Shield className="size-3.5" />
										Admin
									</MenuItem>
								)}
								<Separator className="h-px bg-border" />
								<MenuItem
									id="signout"
									className="block cursor-pointer px-3 py-2 text-[13px] text-destructive outline-none transition-colors focus:bg-destructive/10 max-md:flex max-md:min-h-11 max-md:items-center"
								>
									Sign Out
								</MenuItem>
							</Menu>
						</Popover>
					</MenuTrigger>
				) : null}
			</div>

			<ApiTokensDialog isOpen={tokensDialog.isOpen} onClose={tokensDialog.close} />
			<McpDialog isOpen={mcpDialog.isOpen} onClose={mcpDialog.close} />
			<OrgIntegrationsDialog
				isOpen={orgIntegrationsDialog.isOpen}
				onClose={orgIntegrationsDialog.close}
			/>
		</header>
	);
}
