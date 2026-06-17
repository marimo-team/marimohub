import { Component, type ReactNode, type ErrorInfo } from 'react';

interface ErrorBoundaryProps {
	children: ReactNode;
	fallback?: ReactNode;
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
						<button
							onClick={this.handleRetry}
							className="mt-2 border border-input bg-background px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary"
						>
							Try again
						</button>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
