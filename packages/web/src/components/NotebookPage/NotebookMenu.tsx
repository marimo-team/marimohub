import type { ReactNode } from 'react';
import { CalendarClock, GitBranch, Image, Pencil } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { GitSourceDetails } from '@/components/Notebook/GitSourcePopover';
import { DialogModal, DropdownMenu } from '@/components/ui';
import type { DropdownMenuOption } from '@/components/ui';
import { useDisclosure } from '@/hooks/useDisclosure';

interface NotebookMenuProps {
	projectId: string;
	notebookId: string;
	title: string;
	author?: ReactNode;
	isGit: boolean;
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
	isGit,
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
			icon: <CalendarClock className="size-3.5" />,
		});
	if (onEditThumbnail)
		options.push({
			id: 'thumbnail',
			label: 'Edit thumbnail…',
			icon: <Image className="size-3.5" />,
		});
	if (isGit)
		options.push({
			id: 'source',
			label: 'Git source details…',
			icon: <GitBranch className="size-3.5" />,
			separatorBefore: options.length > 0,
		});

	return (
		<>
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
					else if (action === 'jobs')
						void navigate(`/projects/${projectId}/notebooks/${notebookId}/jobs`);
					else if (action === 'source') source.open();
				}}
			/>
			{source.isOpen && (
				<DialogModal isOpen onClose={source.close} title="Git source details" width="sm">
					<GitSourceDetails projectId={projectId} notebookId={notebookId} canSync={canSync} />
				</DialogModal>
			)}
		</>
	);
}
