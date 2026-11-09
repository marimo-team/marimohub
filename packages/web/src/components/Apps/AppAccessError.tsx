import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';

export function AppAccessError({
	error,
	onRetry,
	isRetrying,
}: {
	error: Error;
	onRetry?: () => void;
	isRetrying?: boolean;
}) {
	return (
		<div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
			<h1 className="text-lg font-semibold">Unable to open</h1>
			<p className="text-sm text-muted-foreground">{error.message}</p>
			{onRetry ? (
				<Button onPress={onRetry} isDisabled={isRetrying}>
					Retry
				</Button>
			) : (
				<Link to="/apps">Back to apps</Link>
			)}
		</div>
	);
}
