import { Link } from 'react-router-dom';
import { MenuTrigger, Button, Popover, Menu, MenuItem, Separator } from 'react-aria-components';
import { ChevronDown, Copy, Moon, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { Brand } from '@/components/ui';

export function Header() {
	const { user, signOut } = useAuth();
	const { theme, toggleTheme } = useTheme();

	return (
		<header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between border-b bg-background/85 px-4 backdrop-blur-md max-md:px-3">
			<Link
				to="/"
				aria-label="marimohub home"
				className="rounded-lg outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
			>
				<Brand wordmarkClassName="max-md:hidden" />
			</Link>

			<div className="ml-auto flex items-center gap-2">
				<Button
					onPress={toggleTheme}
					aria-label="Toggle theme"
					className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				>
					{theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
				</Button>

				{user && (
					<MenuTrigger>
						<Button
							aria-label="User menu"
							className="flex items-center gap-1.5 rounded-full border border-input bg-card p-1 pr-2.5 shadow-xs transition-all hover:border-ring hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:min-h-11"
						>
							<span className="flex size-6 items-center justify-center rounded-full bg-gradient-to-br from-teal-500/15 to-teal-600/25 text-[11px] font-semibold text-primary ring-1 ring-primary/20">
								{user.email.charAt(0).toUpperCase()}
							</span>
							<ChevronDown className="size-3 text-muted-foreground" />
						</Button>
						<Popover
							placement="bottom end"
							className="z-50 min-w-[180px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg entering:animate-in entering:fade-in-0 entering:zoom-in-95 exiting:animate-out exiting:fade-out-0 exiting:zoom-out-95"
						>
							<Menu
								className="outline-none"
								onAction={(key) => {
									if (key === 'signout') signOut();
									else if (key === 'copy-id') {
										void navigator.clipboard.writeText(user.id);
										toast.success('User id copied');
									}
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
				)}
			</div>
		</header>
	);
}
