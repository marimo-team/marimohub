import type { InitialRoutes } from '@/lib/initialRoute';
import { useSearchAccess } from '@/hooks/useSearchAccess';
import { SEARCH_ROUTE, PROJECT_SEARCH_ROUTE } from '@/lib/workspaceSearch';
import { useWorkspaceSearchShortcut } from '@/hooks/useWorkspaceSearchShortcut';
import { Suspense } from 'react';
import { lazyRoute } from '@/lib/lazyRoute';
import { BrowserRouter, Routes, Route, Navigate, matchRoutes } from 'react-router-dom';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { ThemeProvider } from '@/context/ThemeContext';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { ProjectSourceGate } from '@/components/Workspace/ProjectSourceGate';
import { ProjectRoute } from '@/components/Project/projectRoute';
import { AppEntryPage } from '@/components/Apps/AppEntryPage';
import { AppLinkPage } from '@/components/NotebookPage/AppLinkPage';
import { SignIn } from '@/components/SignIn/SignIn';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Button } from '@/components/ui/Button';
import { Toaster } from '@/components/ui/sonner';
import { ApiRequestError } from '@/api/client';
import { appBasePath, withBasePath } from '@/lib/basePath';
import { RetainedEditorRoute } from '@/components/NotebookPage/RetainedEditorRoute';

const WorkspaceLayout = lazyRoute(async () => {
	const module = await import('@/components/Workspace/WorkspaceLayout');
	return { default: module.WorkspaceLayout };
});

const PreviewsPage = lazyRoute(async () => {
	const module = await import('@/components/Previews/PreviewsPage');
	return { default: module.PreviewsPage };
});
const PreviewPage = lazyRoute(async () => {
	const module = await import('@/components/Previews/PreviewPage');
	return { default: module.PreviewPage };
});
const WorkspaceHome = lazyRoute(async () => {
	const module = await import('@/components/Workspace/WorkspaceHome');
	return { default: module.WorkspaceHome };
});
const ProjectAlertsPage = lazyRoute(async () => {
	const module = await import('@/components/Workspace/ProjectAlertsPage');
	return { default: module.ProjectAlertsPage };
});
const ProjectJobsPage = lazyRoute(async () => {
	const module = await import('@/components/Workspace/ProjectJobsPage');
	return { default: module.ProjectJobsPage };
});
const ProjectSettingsPage = lazyRoute(async () => {
	const module = await import('@/components/Workspace/ProjectSettingsPage');
	return { default: module.ProjectSettingsPage };
});
const ProjectList = lazyRoute(async () => {
	const module = await import('@/components/ProjectList/ProjectList');
	return { default: module.ProjectList };
});
const AppsPage = lazyRoute(async () => {
	const module = await import('@/components/Apps/AppsPage');
	return { default: module.AppsPage };
});
const SnapshotPage = lazyRoute(async () => {
	const module = await import('@/components/NotebookPage/SnapshotPage');
	return { default: module.SnapshotPage };
});
const JobsPage = lazyRoute(async () => {
	const module = await import('@/components/Jobs/JobsPage');
	return { default: module.JobsPage };
});
const AdminLayout = lazyRoute(async () => {
	const module = await import('@/components/Admin/AdminLayout');
	return { default: module.AdminLayout };
});
const SearchPage = lazyRoute(() => import('@/components/Search/SearchPage'));
const ChatPage = lazyRoute(() => import('@/components/Chat/ChatPage'));
const AuditLogPage = lazyRoute(() => import('@/components/AuditLog/AuditLogPage'));
const DataBrowserPage = lazyRoute(() => import('@/components/DataBrowser/DataBrowserPage'));
const AdminUsersPage = lazyRoute(() => import('@/components/Admin/AdminUsersPage'));
const AdminSettingsPage = lazyRoute(() => import('@/components/Admin/AdminSettingsPage'));
const AdminColorsPage = lazyRoute(() => import('@/components/Admin/AdminColorsPage'));
const AdminRuntimePage = lazyRoute(() => import('@/components/Admin/AdminRuntimePage'));
const AdminDebugPage = lazyRoute(() => import('@/components/Admin/AdminDebugPage'));
const AdminPolicyAnalyzerPage = lazyRoute(
	() => import('@/components/Admin/AdminPolicyAnalyzerPage'),
);
const CliLoginPage = lazyRoute(async () => {
	const module = await import('@/components/Account/CliLoginPage');
	return { default: module.CliLoginPage };
});
const CliDeviceLoginPage = lazyRoute(async () => {
	const module = await import('@/components/Account/CliDeviceLoginPage');
	return { default: module.CliDeviceLoginPage };
});
const OAuthConsentPage = lazyRoute(async () => {
	const module = await import('@/components/Account/OAuthConsentPage');
	return { default: module.OAuthConsentPage };
});

// Pages rendered outside StandardLayout; every other path renders inside WorkspaceLayout.
const fullScreenRoutes = [
	{ path: '/app/*', element: <AppLinkPage /> },
	{ path: '/cli/login', element: <CliLoginPage /> },
	{ path: '/cli/device', element: <CliDeviceLoginPage /> },
	{ path: '/oauth/consent', element: <OAuthConsentPage /> },
	{ path: '/projects/:pid/notebooks/:nid', element: <AppEntryPage variant="edit" /> },
	// The shared app, full-screen like the editor.
	{ path: '/projects/:pid/notebooks/:nid/app', element: <AppEntryPage /> },
	// The last HTML snapshot, sandbox-free (no session is ever started).
	{ path: '/projects/:pid/notebooks/:nid/snapshot', element: <SnapshotPage /> },
	{ path: '/projects/:pid/notebooks/:nid/previews', element: <PreviewsPage /> },
	{ path: '/projects/:pid/notebooks/:nid/previews/:previewId', element: <PreviewPage /> },
];

// Every workspace page renders inside the layout, so fetch it alongside `/me` instead of after it.
if (!matchRoutes(fullScreenRoutes, window.location.pathname, appBasePath())) {
	WorkspaceLayout.preload();
}

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

function StandardLayout({ initialRoutes }: { initialRoutes: InitialRoutes }) {
	const Layout = initialRoutes.Layout ?? WorkspaceLayout;
	const Home = initialRoutes.Home ?? WorkspaceHome;
	const Project = initialRoutes.Project ?? ProjectRoute;
	const Projects = initialRoutes.Projects ?? ProjectList;
	const { user } = useAuth();
	return (
		<Layout>
			<AppErrorBoundary>
				<Suspense fallback={<PageFallback />}>
					<Routes>
						<Route path="/" element={<Home />} />
						<Route path={SEARCH_ROUTE} element={<SearchPage />} />
						<Route path={PROJECT_SEARCH_ROUTE} element={<SearchPage />} />
						<Route path="/apps" element={<AppsPage />} />
						<Route
							path="/projects"
							element={
								user?.app_only && !user.can_create_projects ? (
									<Navigate to="/apps" replace />
								) : (
									<Projects />
								)
							}
						/>
						<Route path="/projects/:pid" element={<ProjectSourceGate />}>
							<Route index element={<Project />} />
							<Route path="members" element={<ProjectSettingsPage section="members" />} />
							<Route path="integrations" element={<ProjectSettingsPage section="integrations" />} />
							<Route path="alerts" element={<ProjectAlertsPage />} />
							<Route path="chat" element={<ChatPage />} />
							<Route path="jobs" element={<ProjectJobsPage />} />
							<Route path="notebooks/:nid/jobs" element={<JobsPage />} />
							<Route path="data" element={<DataBrowserPage />} />
							<Route path="data/:iid" element={<DataBrowserPage />} />
						</Route>
						<Route path="/admin" element={<AdminLayout />}>
							<Route index element={<Navigate to="/admin/users" replace />} />
							<Route path="users" element={<AdminUsersPage />} />
							<Route path="settings" element={<AdminSettingsPage />} />
							<Route path="colors" element={<AdminColorsPage />} />
							<Route path="audit-logs" element={<AuditLogPage />} />
							<Route path="policy-analyzer" element={<AdminPolicyAnalyzerPage />} />
							<Route path="debug" element={<AdminDebugPage />} />
							<Route path="runtime" element={<AdminRuntimePage />} />
						</Route>
						<Route path="*" element={<NotFoundPage />} />
					</Routes>
				</Suspense>
			</AppErrorBoundary>
		</Layout>
	);
}

function AppContent({ initialRoutes }: { initialRoutes: InitialRoutes }) {
	const { available } = useSearchAccess();
	const { user } = useAuth();
	useWorkspaceSearchShortcut(available);
	return (
		<>
			<AppErrorBoundary>
				<Suspense fallback={<PageFallback />}>
					<RetainedEditorRoute key={user?.id} editor={<AppEntryPage variant="edit" />}>
						<Routes>
							{fullScreenRoutes.map(({ path, element }) =>
								path === '/projects/:pid/notebooks/:nid' ? null : (
									<Route key={path} path={path} element={element} />
								),
							)}
							<Route path="*" element={<StandardLayout initialRoutes={initialRoutes} />} />
						</Routes>
					</RetainedEditorRoute>
				</Suspense>
			</AppErrorBoundary>

			<Toaster />
		</>
	);
}

function App({ initialRoutes = {} }: { initialRoutes?: InitialRoutes }) {
	return (
		<AppErrorBoundary>
			<BrowserRouter basename={appBasePath()}>
				<ThemeProvider>
					<AuthProvider>
						<AuthGate>
							<AppContent initialRoutes={initialRoutes} />
						</AuthGate>
					</AuthProvider>
				</ThemeProvider>
			</BrowserRouter>
		</AppErrorBoundary>
	);
}

export default App;
