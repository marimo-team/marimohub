import { Camera, Copy, Play, Share2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { DropdownMenu } from '@/components/ui';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { withBasePath } from '@/lib/basePath';

interface ShareMenuProps {
	projectId: string;
	notebookId: string;
	title: string;
	canRunApp: boolean;
}

export function ShareMenu({ projectId, notebookId, title, canRunApp }: ShareMenuProps) {
	const navigate = useNavigate();
	const { copy } = useCopyToClipboard();
	const notebookPath = `/projects/${projectId}/notebooks/${notebookId}`;

	const handleAction = (action: string) => {
		if (action === 'static-outputs') {
			void navigate(`${notebookPath}/snapshot`, { state: { title } });
		} else if (action === 'run-app') {
			void navigate(`${notebookPath}/app`, { state: { title } });
		} else if (action === 'copy-url') {
			const url = new URL(withBasePath(notebookPath), window.location.origin).toString();
			void copy(url).then((copied) => copied && toast.success('Notebook URL copied'));
		}
	};

	return (
		<DropdownMenu
			label="Share notebook"
			icon={<Share2 className="size-3.5" />}
			triggerClassName="h-[26px] w-7 rounded-md border border-input hover:border-primary hover:bg-transparent hover:text-primary max-md:h-11 max-md:w-11"
			options={[
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
				{
					id: 'copy-url',
					label: 'Copy URL',
					icon: <Copy className="size-3.5" />,
					separatorBefore: true,
				},
			]}
			onAction={handleAction}
		/>
	);
}
