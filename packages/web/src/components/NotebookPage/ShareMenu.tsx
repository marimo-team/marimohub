import { useDisclosure } from '@/hooks/useDisclosure';
import { AppLinksDialog } from './AppLinksDialog';
import { Copy, Link, Share2 } from 'lucide-react';
import { useLocation } from 'react-router-dom';
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
	showLabel = false,
}: {
	showLabel?: boolean;
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
			triggerLabel={showLabel ? 'Share' : undefined}
			icon={showLabel ? undefined : <Share2 className="size-3.5" />}
			triggerClassName={
				showLabel
					? 'border border-input'
					: 'h-[26px] w-7 rounded-md border border-input hover:border-primary hover:bg-transparent hover:text-primary max-md:h-11 max-md:w-11'
			}
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
	canManageLinks?: boolean;
	isApp?: boolean;
}

export function ShareMenu({
	projectId,
	notebookId,
	canManageLinks = false,
	isApp = false,
}: ShareMenuProps) {
	const links = useDisclosure();
	const location = useLocation();

	return (
		<>
			<ShareUrlMenu
				showLabel
				label={isApp ? 'Share app' : 'Share notebook'}
				successMessage={isApp ? 'App URL copied' : 'Notebook URL copied'}
				options={[{ id: 'app-links', label: 'App links', icon: <Link className="size-3.5" /> }]}
				onAction={(action) => {
					if (action === 'app-links') links.open();
				}}
			/>
			{links.isOpen && (
				<AppLinksDialog
					projectId={projectId}
					notebookId={notebookId}
					canManage={canManageLinks}
					search={location.search}
					onClose={links.close}
				/>
			)}
		</>
	);
}
