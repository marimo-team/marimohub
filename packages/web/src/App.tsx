import { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from '@/context/ThemeContext';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { Header } from '@/components/Header/Header';
import { ProjectList } from '@/components/ProjectList/ProjectList';
import { Home } from '@/components/Home/Home';
import { NotebookPage } from '@/components/NotebookPage/NotebookPage';
import { ErrorBoundary } from '@/components/ui';
import { Toaster } from '@/components/ui/sonner';

function AuthGate({ children }: { children: React.ReactNode }) {
	const { isPending, error } = useAuth();

	if (isPending) {
		return (
			<div className="flex min-h-screen flex-col items-center justify-center gap-3 text-muted-foreground">
				<div className="size-8 animate-spin rounded-full border-[3px] border-border border-t-primary" />
				<p>Loading...</p>
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
				<h1 className="text-xl font-semibold">Authentication Required</h1>
				<p className="text-sm text-muted-foreground">{error.message}</p>
			</div>
		);
	}

	return <>{children}</>;
}

function PageFallback() {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
			<div className="size-8 animate-spin rounded-full border-[3px] border-border border-t-primary" />
		</div>
	);
}

function StandardLayout() {
	return (
		<div className="flex min-h-screen flex-col">
			<Header />
			<main className="flex flex-1 overflow-hidden">
				<ErrorBoundary>
					<Suspense fallback={<PageFallback />}>
						<Routes>
							<Route path="/" element={<ProjectList />} />
							<Route path="/projects/:pid" element={<Home />} />
							<Route path="*" element={<Navigate to="/" replace />} />
						</Routes>
					</Suspense>
				</ErrorBoundary>
			</main>
		</div>
	);
}

function AppContent() {
	return (
		<>
			<ErrorBoundary>
				<Suspense fallback={<PageFallback />}>
					<Routes>
						<Route path="/projects/:pid/notebooks/:nid" element={<NotebookPage />} />
						<Route path="*" element={<StandardLayout />} />
					</Routes>
				</Suspense>
			</ErrorBoundary>

			<Toaster />
		</>
	);
}

function App() {
	return (
		<ErrorBoundary>
			<BrowserRouter>
				<ThemeProvider>
					<AuthProvider>
						<AuthGate>
							<AppContent />
						</AuthGate>
					</AuthProvider>
				</ThemeProvider>
			</BrowserRouter>
		</ErrorBoundary>
	);
}

export default App;
