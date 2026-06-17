import { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from '@/context/ThemeContext';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { Header } from '@/components/Header/Header';
import { Footer } from '@/components/Footer/Footer';
import { ProjectList } from '@/components/ProjectList/ProjectList';
import { Project } from '@/components/Project/Project';
import { NotebookPage } from '@/components/NotebookPage/NotebookPage';
import { SignIn } from '@/components/SignIn/SignIn';
import { ErrorBoundary, Button } from '@/components/ui';
import { Toaster } from '@/components/ui/sonner';
import { ApiRequestError } from '@/api/client';

function AuthGate({ children }: { children: React.ReactNode }) {
	const { isPending, error, user, signIn, refetchUser } = useAuth();

	if (isPending) {
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-3 text-muted-foreground">
				<div className="size-8 animate-spin rounded-full border-[3px] border-border border-t-primary" />
				<p>Loading...</p>
			</div>
		);
	}

	if (!user) {
		// Not signed in (401 from /api/v1/me) → show the sign-in screen. Any other
		// failure (network, 5xx, forbidden) shows an error with retry + sign-in.
		const isUnauthorized = error instanceof ApiRequestError && error.code === 'UNAUTHORIZED';
		if (isUnauthorized) {
			return <SignIn />;
		}

		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
				<div className="flex flex-col gap-1.5">
					<h1 className="text-xl font-semibold">Something went wrong</h1>
					<p className="text-sm text-muted-foreground">
						{error?.message ?? 'Unable to load your account.'}
					</p>
				</div>
				<div className="flex gap-2">
					<Button variant="default" size="md" onPress={() => refetchUser()}>
						Retry
					</Button>
					<Button variant="primary" size="md" onPress={signIn}>
						Sign in
					</Button>
				</div>
				{/* Escape hatch: a lingering/invalid session can wedge the user here with
				    no usable account. Hard-navigate to the logout route to clear the
				    `mh_session` cookie (and hit the IdP end-session) so they can start over. */}
				<Button
					variant="unstyled"
					className="rounded text-sm text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					onPress={() => {
						window.location.href = '/api/auth/logout';
					}}
				>
					Sign out
				</Button>
			</div>
		);
	}

	return children;
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
		<div className="flex min-h-dvh flex-col">
			<Header />
			<main className="flex flex-1 overflow-hidden">
				<ErrorBoundary>
					<Suspense fallback={<PageFallback />}>
						<Routes>
							<Route path="/" element={<ProjectList />} />
							<Route path="/projects/:pid" element={<Project />} />
							<Route path="*" element={<Navigate to="/" replace />} />
						</Routes>
					</Suspense>
				</ErrorBoundary>
			</main>
			<Footer />
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
