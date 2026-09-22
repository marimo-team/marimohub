import { useState } from 'react';
import { AppLinksDialog } from './AppLinksDialog';
import { Camera, Copy, Link, Play, Share2 } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { DropdownMenu } from '@/components/ui';
import type { DropdownMenuOption } from '@/components/ui';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { withBasePath } from '@/lib/basePath';
import { notebookQueryParams } from '@/lib/notebookUrls';

export function ShareUrlMenu({
	label,
	successMessage,
	options = [],
	onAction,
}: {
	label: string;
	successMessage: string;
	options?: DropdownMenuOption[];
	onAction?: (action: string) => void;
}) {
	const location = useLocation();
	const { copy } = useCopyToClipboard();
	return (
		<DropdownMenu
			label={label}
			icon={<Share2 className="size-3.5" />}
			triggerClassName="h-[26px] w-7 rounded-md border border-input hover:border-primary hover:bg-transparent hover:text-primary max-md:h-11 max-md:w-11"
			options={[
				...options,
				{
					id: 'copy-url',
					label: 'Copy URL',
					icon: <Copy className="size-3.5" />,
					separatorBefore: options.length > 0,
				},
			]}
			onAction={(action) => {
				if (action !== 'copy-url') {
					onAction?.(action);
					return;
				}
				const url = new URL(withBasePath(location.pathname), window.location.origin);
				url.search = notebookQueryParams(location.search).toString();
				void copy(url.toString()).then((copied) => copied && toast.success(successMessage));
			}}
		/>
	);
}

interface ShareMenuProps {
	projectId: string;
	notebookId: string;
	title: string;
	canRunApp: boolean;
	canManageLinks?: boolean;
	isApp?: boolean;
}

export function ShareMenu({
	projectId,
	notebookId,
	title,
	canRunApp,
	canManageLinks = false,
	isApp = false,
}: ShareMenuProps) {
	const [linksOpen, setLinksOpen] = useState(false);
	const navigate = useNavigate();
	const location = useLocation();
	const notebookPath = `/projects/${projectId}/notebooks/${notebookId}`;

	const handleAction = (action: string) => {
		const search = notebookQueryParams(location.search).toString();
		const query = search ? `?${search}` : '';
		if (action === 'app-links') {
			setLinksOpen(true);
		} else if (action === 'static-outputs') {
			void navigate(`${notebookPath}/snapshot`, { state: { title } });
		} else if (action === 'run-app') {
			void navigate(`${notebookPath}/app${query}`, { state: { title } });
		}
	};

	return (
		<>
			<ShareUrlMenu
				label={isApp ? 'Share app' : 'Share notebook'}
				successMessage={isApp ? 'App URL copied' : 'Notebook URL copied'}
				options={[
					{ id: 'app-links', label: 'App links', icon: <Link className="size-3.5" /> },
					{
						id: 'static-outputs',
						label: 'View static outputs',
						icon: <Camera className="size-3.5" />,
					},
					...(canRunApp
						? [
								{
									id: 'run-app',
									label: 'Run as app',
									icon: <Play className="size-3.5" />,
								},
							]
						: []),
				]}
				onAction={handleAction}
			/>
			{linksOpen && (
				<AppLinksDialog
					projectId={projectId}
					notebookId={notebookId}
					canManage={canManageLinks}
					search={location.search}
					onClose={() => setLinksOpen(false)}
				/>
			)}
		</>
	);
}
