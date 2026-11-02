import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { Menu, X } from 'lucide-react';
import { Header } from '@/components/Header/Header';
import { AnnouncementBanner } from '@/components/Shell/AnnouncementBanner';
import { IconButton } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { useQuery } from '@tanstack/react-query';
import { projectQueryOptions } from '@/api/hooks';
import { workspaceRoute } from './navigation';
import { rememberProject } from './lastProject';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import type { WorkspaceNavigationSlots } from './navigation';

export function WorkspaceLayout({
	children,
	slots,
}: {
	children: ReactNode;
	slots?: WorkspaceNavigationSlots;
}) {
	const { user } = useAuth();
	const location = useLocation();
	const isMobile = useIsMobile();
	const { pid } = workspaceRoute(location.pathname);
	const selectedProject = useQuery({
		...projectQueryOptions(pid ?? ''),
		enabled: Boolean(pid && user && !user.app_only),
		throwOnError: false,
	});
	const role = selectedProject.isError ? null : selectedProject.data?.your_role;
	useEffect(() => {
		if (pid && user && !user.app_only && role && role !== 'app-user') rememberProject(user.id, pid);
	}, [pid, user, role]);
	const [openedAt, setOpenedAt] = useState<string | null>(null);
	const open = openedAt === location.key;
	const close = () => setOpenedAt(null);
	const showNavigation = Boolean(
		user && !user.app_only && !matchPath('/apps/*', location.pathname),
	);
	return (
		<div className="flex h-dvh min-w-0 flex-col overflow-hidden">
			<a
				href="#workspace-content"
				className="sr-only z-50 rounded bg-background p-3 focus:not-sr-only focus:absolute focus:ring-2 focus:ring-ring"
			>
				Skip to content
			</a>
			<Header
				navigationTrigger={
					showNavigation && isMobile ? (
						<IconButton
							label="Open navigation"
							aria-expanded={open}
							aria-controls="workspace-navigation"
							onPress={() => setOpenedAt(location.key)}
							className="mr-2"
						>
							<Menu className="size-5" aria-hidden />
						</IconButton>
					) : undefined
				}
			/>
			<AnnouncementBanner />
			<div className="flex min-h-0 min-w-0 flex-1">
				{showNavigation && !isMobile ? (
					<aside
						aria-label="Workspace"
						className="flex w-60 shrink-0 border-r border-sidebar-border bg-sidebar max-lg:w-52"
					>
						<WorkspaceSidebar slots={slots} />
					</aside>
				) : null}
				<main
					id="workspace-content"
					tabIndex={-1}
					className="flex min-h-0 min-w-0 flex-1 overflow-hidden outline-none"
				>
					{children}
				</main>
			</div>
			{showNavigation && isMobile ? (
				<ModalOverlay
					isOpen={open}
					onOpenChange={(value) => setOpenedAt(value ? location.key : null)}
					isDismissable
					className="fixed inset-0 z-50 bg-black/40"
				>
					<Modal className="flex h-dvh w-80 max-w-[calc(100vw-2rem)] bg-sidebar shadow-xl">
						<Dialog id="workspace-navigation" className="flex min-h-0 w-full flex-col outline-none">
							<div className="flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
								<Heading slot="title" className="text-sm font-semibold">
									Workspace
								</Heading>
								<IconButton label="Close navigation" onPress={close}>
									<X className="size-5" aria-hidden />
								</IconButton>
							</div>
							<WorkspaceSidebar onNavigate={close} slots={slots} />
						</Dialog>
					</Modal>
				</ModalOverlay>
			) : null}
		</div>
	);
}
