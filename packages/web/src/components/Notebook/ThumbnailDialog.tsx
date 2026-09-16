import { lazy, Suspense } from 'react';
const ThumbnailEditor = lazy(() => import('./ThumbnailEditor'));
export function ThumbnailDialog(props: {
	projectId: string;
	notebookId: string;
	isOpen: boolean;
	onClose: () => void;
}) {
	return props.isOpen ? (
		<Suspense fallback={null}>
			<ThumbnailEditor {...props} />
		</Suspense>
	) : null;
}
