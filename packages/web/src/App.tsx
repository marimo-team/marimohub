import { useSearchAccess } from '@/hooks/useSearchAccess';
import { SEARCH_ROUTE, PROJECT_SEARCH_ROUTE } from '@/lib/workspaceSearch';
import { useWorkspaceSearchShortcut } from '@/hooks/useWorkspaceSearchShortcut';
import { PreviewsPage } from '@/components/Previews/PreviewsPage';
import { PreviewPage } from '@/components/Previews/PreviewPage';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { ThemeProvider } from '@/context/ThemeContext';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { WorkspaceLayout } from '@/components/Workspace/WorkspaceLayout';
import { WorkspaceHome } from '@/components/Workspace/WorkspaceHome';
import { ProjectJobsPage } from '@/components/Workspace/ProjectJobsPage';
import { ProjectSettingsPage } from '@/components/Workspace/ProjectSettingsPage';
import { ProjectSourceGate } from '@/components/Workspace/ProjectSourceGate';
import { ProjectList } from '@/components/ProjectList/ProjectList';
import { AppsPage } from '@/components/Apps/AppsPage';
import { Project } from '@/components/Project/Project';
import { AppEntryPage } from '@/components/Apps/AppEntryPage';
import { AppLinkPage } from '@/components/NotebookPage/AppLinkPage';
import { SnapshotPage } from '@/components/NotebookPage/SnapshotPage';
import { JobsPage } from '@/components/Jobs/JobsPage';
import { SignIn } from '@/components/SignIn/SignIn';
import { ErrorBoundary, Button } from '@/components/ui';
import { Toaster } from '@/components/ui/sonner';
import { ApiRequestError } from '@/api/client';
import { AdminLayout } from '@/components/Admin/AdminLayout';
import { appBasePath, withBasePath } from '@/lib/basePath';

const SearchPage = lazy(() => import('@/components/Search/SearchPage'));
const AuditLogPage = lazy(() => import('@/components/AuditLog/AuditLogPage'));
const DataBrowserPage = lazy(() => import('@/components/DataBrowser/DataBrowserPage'));
const AdminUsersPage = lazy(() => import('@/components/Admin/AdminUsersPage'));
const AdminSettingsPage = lazy(() => import('@/components/Admin/AdminSettingsPage'));
const AdminRuntimePage = lazy(() => import('@/components/Admin/AdminRuntimePage'));
const AdminDebugPage = lazy(() => import('@/components/Admin/AdminDebugPage'));
const AdminPolicyAnalyzerPage = lazy(() => import('@/components/Admin/AdminPolicyAnalyzerPage'));
const CliLoginPage = lazy(() =>
	import('@/components/Account/CliLoginPage').then((module) => ({ default: module.CliLoginPage })),
);
const CliDeviceLoginPage = lazy(() =>
	import('@/components/Account/CliDeviceLoginPage').then((module) => ({
		default: module.CliDeviceLoginPage,
	})),
);
const OAuthConsentPage = lazy(() =>
	import('@/components/Account/OAuthConsentPage').then((module) => ({
		default: module.OAuthConsentPage,
	})),
);

function AppErrorBoundary({ children }: { children: React.ReactNode }) {
	return (
		<QueryErrorResetBoundary>
			{({ reset }) => <ErrorBoundary onRetry={reset}>{children}</ErrorBoundary>}
		</QueryErrorResetBoundary>
	);
}

function NotFoundPage() {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
			<h1 className="text-xl font-semibold">Page not found</h1>
			<p className="text-sm text-muted-foreground">
				The page may have moved, or you may not have access to it.
			</p>
			<Button variant="default" onPress={() => window.location.assign(withBasePath('/projects'))}>
				Back to projects
			</Button>
		</div>
	);
}

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
		if (!error || isUnauthorized) {
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
						window.location.href = withBasePath('/api/auth/logout');
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
	const { user } = useAuth();
	return (
		<WorkspaceLayout>
			<AppErrorBoundary>
				<Suspense fallback={<PageFallback />}>
					<Routes>
						<Route path="/" element={<WorkspaceHome />} />
						<Route path={SEARCH_ROUTE} element={<SearchPage />} />
						<Route path={PROJECT_SEARCH_ROUTE} element={<SearchPage />} />
						<Route path="/apps" element={<AppsPage />} />
						<Route
							path="/projects"
							element={
								user?.app_only && !user.can_create_projects ? (
									<Navigate to="/apps" replace />
								) : (
									<ProjectList />
								)
							}
						/>
						<Route path="/projects/:pid" element={<ProjectSourceGate />}>
							<Route index element={<Project />} />
							<Route path="members" element={<ProjectSettingsPage section="members" />} />
							<Route path="integrations" element={<ProjectSettingsPage section="integrations" />} />
							<Route path="jobs" element={<ProjectJobsPage />} />
							<Route path="notebooks/:nid/jobs" element={<JobsPage />} />
							<Route path="data" element={<DataBrowserPage />} />
							<Route path="data/:iid" element={<DataBrowserPage />} />
						</Route>
						<Route path="/admin" element={<AdminLayout />}>
							<Route index element={<Navigate to="/admin/users" replace />} />
							<Route path="users" element={<AdminUsersPage />} />
							<Route path="settings" element={<AdminSettingsPage />} />
							<Route path="audit-logs" element={<AuditLogPage />} />
							<Route path="policy-analyzer" element={<AdminPolicyAnalyzerPage />} />
							<Route path="debug" element={<AdminDebugPage />} />
							<Route path="runtime" element={<AdminRuntimePage />} />
						</Route>
						<Route path="*" element={<NotFoundPage />} />
					</Routes>
				</Suspense>
			</AppErrorBoundary>
		</WorkspaceLayout>
	);
}

function AppContent() {
	const { available } = useSearchAccess();
	useWorkspaceSearchShortcut(available);
	return (
		<>
			<AppErrorBoundary>
				<Suspense fallback={<PageFallback />}>
					<Routes>
						<Route path="/app/*" element={<AppLinkPage />} />
						<Route path="/cli/login" element={<CliLoginPage />} />
						<Route path="/cli/device" element={<CliDeviceLoginPage />} />
						<Route path="/oauth/consent" element={<OAuthConsentPage />} />
						<Route path="/projects/:pid/notebooks/:nid" element={<AppEntryPage variant="edit" />} />
						{/* The shared app, full-screen like the editor (outside StandardLayout). */}
						<Route path="/projects/:pid/notebooks/:nid/app" element={<AppEntryPage />} />
						{/* The last HTML snapshot, sandbox-free (no session is ever started). */}
						<Route path="/projects/:pid/notebooks/:nid/snapshot" element={<SnapshotPage />} />
						<Route path="/projects/:pid/notebooks/:nid/previews" element={<PreviewsPage />} />
						<Route
							path="/projects/:pid/notebooks/:nid/previews/:previewId"
							element={<PreviewPage />}
						/>
						<Route path="*" element={<StandardLayout />} />
					</Routes>
				</Suspense>
			</AppErrorBoundary>

			<Toaster />
		</>
	);
}

function App() {
	return (
		<AppErrorBoundary>
			<BrowserRouter basename={appBasePath()}>
				<ThemeProvider>
					<AuthProvider>
						<AuthGate>
							<AppContent />
						</AuthGate>
					</AuthProvider>
				</ThemeProvider>
			</BrowserRouter>
		</AppErrorBoundary>
	);
}

export default App;
