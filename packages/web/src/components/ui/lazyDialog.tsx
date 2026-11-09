import { lazy, Suspense, useState } from 'react';
import type { FunctionComponent } from 'react';
import { toast } from 'sonner';
import { ErrorBoundary } from './ErrorBoundary';
import { isChunkLoadError } from '@/lib/lazyRoute';

interface DialogProps {
	isOpen: boolean;
	onClose: () => void;
}

export function lazyDialog<Props extends DialogProps>(
	load: () => Promise<{ default: FunctionComponent<Props> }>,
) {
	return function LazyDialog(props: Props) {
		const [Dialog, setDialog] = useState(() => lazy(load));
		const [hasOpened, setHasOpened] = useState(props.isOpen);
		if (props.isOpen && !hasOpened) setHasOpened(true);
		if (!hasOpened) return null;

		const handleError = (error: Error) => {
			props.onClose();
			setHasOpened(false);
			// React.lazy retains rejected imports, so reopening needs a fresh lazy component.
			setDialog(() => lazy(load));
			toast.error(
				'Unable to open dialog.',
				isChunkLoadError(error)
					? {
							action: { label: 'Reload page', onClick: () => window.location.reload() },
						}
					: undefined,
			);
		};

		return (
			<ErrorBoundary fallback={null} onError={handleError}>
				<Suspense fallback={null}>
					<Dialog {...props} />
				</Suspense>
			</ErrorBoundary>
		);
	};
}
