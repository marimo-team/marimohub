import { lazyDialog } from '@/components/ui/lazyDialog';

interface ThumbnailDialogProps {
	projectId: string;
	notebookId: string;
	isOpen: boolean;
	onClose: () => void;
}

export const ThumbnailDialog = lazyDialog<ThumbnailDialogProps>(async () => {
	const { default: ThumbnailEditor } = await import('./ThumbnailEditor');
	// Unmount on close so the next open starts without the previous image and crop.
	return {
		default: function ThumbnailDialogContent(props) {
			return props.isOpen ? <ThumbnailEditor {...props} /> : null;
		},
	};
});
