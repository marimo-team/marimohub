import type { ReactNode } from 'react';
import { CalendarClock, GitBranch, Image, Pencil } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { RouterProvider } from 'react-aria-components';
import { GitSourceDetails } from '@/components/Notebook/GitSourcePopover';
import { Button, DialogModal, DropdownMenu, Tooltip } from '@/components/ui';
import type { DropdownMenuOption } from '@/components/ui';
import { useDisclosure } from '@/hooks/useDisclosure';

interface NotebookMenuProps {
	projectId: string;
	notebookId: string;
	title: string;
	author?: ReactNode;
	gitSource?: { repo: string; branch: string };
	canSync: boolean;
	showJobs: boolean;
	onRename?: () => void;
	onEditThumbnail?: () => void;
}

export function NotebookMenu({
	projectId,
	notebookId,
	title,
	author,
	gitSource,
	canSync,
	showJobs,
	onRename,
	onEditThumbnail,
}: NotebookMenuProps) {
	const navigate = useNavigate();
	const source = useDisclosure();
	const options: DropdownMenuOption[] = [];
	if (onRename)
		options.push({
			id: 'rename',
			label: 'Rename notebook…',
			icon: <Pencil className="size-3.5" />,
		});
	if (showJobs)
		options.push({
			id: 'jobs',
			label: 'Jobs & schedules',
			href: `/projects/${projectId}/notebooks/${notebookId}/jobs`,
			icon: <CalendarClock className="size-3.5" />,
		});
	if (onEditThumbnail)
		options.push({
			id: 'thumbnail',
			label: 'Edit thumbnail…',
			icon: <Image className="size-3.5" />,
		});
	if (gitSource)
		options.push({
			id: 'source',
			label: 'Git source details…',
			icon: <GitBranch className="size-3.5" />,
			separatorBefore: options.length > 0,
		});

	return (
		<>
			<RouterProvider
				navigate={(href) => {
					void navigate(href);
				}}
			>
				<DropdownMenu
					label={`${title} — notebook menu`}
					tooltip={title}
					triggerLabel={title}
					triggerClassName="max-w-full shrink justify-start gap-1.5 text-[13px] font-medium text-foreground"
					header={
						<div className="max-w-xs break-words">
							<div className="font-medium">{title}</div>
							{author && (
								<div className="mt-1 flex items-center gap-1 text-muted-foreground">
									Created by {author}
								</div>
							)}
						</div>
					}
					options={options}
					onAction={(action) => {
						if (action === 'rename') onRename?.();
						else if (action === 'thumbnail') onEditThumbnail?.();
						else if (action === 'source') source.open();
					}}
				/>
			</RouterProvider>
			{gitSource && (
				<Tooltip content={`${gitSource.repo} · ${gitSource.branch} — Git source details`}>
					<Button
						variant="unstyled"
						aria-label={`Git branch ${gitSource.branch} — details`}
						className="flex h-8 max-w-40 shrink-0 items-center gap-1.5 rounded-md border border-input px-2 text-xs text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring max-md:hidden"
						onPress={source.open}
					>
						<GitBranch className="size-3.5 shrink-0" />
						<span className="truncate">{gitSource.branch}</span>
					</Button>
				</Tooltip>
			)}
			{source.isOpen && (
				<DialogModal isOpen onClose={source.close} title="Git source details" width="sm">
					<GitSourceDetails projectId={projectId} notebookId={notebookId} canSync={canSync} />
				</DialogModal>
			)}
		</>
	);
}
