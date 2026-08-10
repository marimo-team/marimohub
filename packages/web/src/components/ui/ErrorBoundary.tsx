import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { Button } from './Button';

interface ErrorBoundaryProps {
	children: ReactNode;
	fallback?: ReactNode;
	onRetry?: () => void;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
		console.error('[ErrorBoundary] Caught error:', error, errorInfo.componentStack);
	}

	handleRetry = (): void => {
		this.props.onRetry?.();
		this.setState({ hasError: false, error: null });
	};

	render(): ReactNode {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}

			return (
				<div className="flex min-h-[50vh] flex-1 items-center justify-center p-8">
					<div className="flex flex-col items-center gap-3 text-center">
						<h2 className="text-lg font-semibold">Something went wrong</h2>
						<p className="text-sm text-muted-foreground">
							{this.state.error?.message || 'An unexpected error occurred'}
						</p>
						<Button variant="default" className="mt-2" onPress={this.handleRetry}>
							Try again
						</Button>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
