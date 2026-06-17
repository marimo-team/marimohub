import { Link } from 'react-router-dom';
import { MenuTrigger, Button, Popover, Menu, MenuItem, Separator } from 'react-aria-components';
import { ChevronDown, Circle, Copy, Moon, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';

export function Header() {
	const { user, signOut } = useAuth();
	const { theme, toggleTheme } = useTheme();

	return (
		<header className="relative flex h-14 items-center justify-between border-b bg-background px-4 max-md:px-3">
			<Link
				to="/"
				aria-label="marimohub home"
				className="flex items-center gap-2 rounded text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
			>
				<Circle className="size-5" />
				<span className="font-mono text-sm font-semibold tracking-[2px] max-md:hidden">
					MARIMOHUB
				</span>
			</Link>

			<div className="ml-auto flex items-center gap-2">
				<Button
					onPress={toggleTheme}
					aria-label="Toggle theme"
					className="flex size-9 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				>
					{theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
				</Button>

				{user && (
					<MenuTrigger>
						<Button
							aria-label="User menu"
							className="flex items-center gap-2 rounded-md border border-input p-1 pr-3 transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:min-h-11"
						>
							<span className="flex size-6 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-primary">
								{user.email.charAt(0).toUpperCase()}
							</span>
							<ChevronDown className="size-3 text-foreground" />
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
