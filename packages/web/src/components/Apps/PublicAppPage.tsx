import { useEffect } from 'react';
import { Copy } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { isPublicAppNotFound, usePublicAppQuery } from '@/api/publicApps';
import type { PublicAppInfo } from '@/api/publicApps';
import { NotebookFrame } from '@/components/NotebookPage/NotebookFrame';
import { SignIn } from '@/components/SignIn/SignIn';
import { Brand } from '@/components/ui/Brand';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { PageTitle } from '@/components/ui/PageTitle';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useNotebookFrameLocation } from '@/hooks/useNotebookFrameLocation';
import { usePublicAppVisit } from '@/hooks/usePublicAppVisit';
import { appBasePath } from '@/lib/basePath';

export function extractAppLinkSlug(pathname: string): string {
	const base = appBasePath();
	const relative =
		base !== '/' && pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
	const match = /^\/app\/(.+)$/.exec(relative);
	if (!match) return '';
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}

export function PublicAppLinkPage() {
	const location = useLocation();
	const slug = extractAppLinkSlug(location.pathname);
	const query = usePublicAppQuery(slug, slug.length > 0);

	if (query.isPending) {
		return (
			<output className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
				Opening app…
			</output>
		);
	}
	if (query.isError || !query.data) {
		if (!query.error || isPublicAppNotFound(query.error)) {
			return <SignIn />;
		}
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6" role="alert">
				<h1 className="text-lg font-semibold">Unable to open app</h1>
				<p className="text-sm text-muted-foreground">{query.error.message}</p>
				<Button onPress={() => void query.refetch()}>Try again</Button>
			</div>
		);
	}
	return <PublicAppPage app={query.data} isSignedIn={false} />;
}

export function PublicAppPage({ app, isSignedIn }: { app: PublicAppInfo; isSignedIn: boolean }) {
	const { signIn } = useAuth();
	const { theme } = useTheme();
	const { copy } = useCopyToClipboard();
	const { sandboxUrl, isProvisioning, error, ended, start } = usePublicAppVisit(
		app.slug,
		app.heartbeat_interval_seconds,
	);
	const {
		iframeSrc: src,
		frameKey,
		latestSrc,
		onQuery,
	} = useNotebookFrameLocation(sandboxUrl ?? undefined, theme, true);

	useEffect(() => {
		const meta = document.createElement('meta');
		meta.name = 'robots';
		meta.content = 'noindex, nofollow';
		document.head.append(meta);
		return () => {
			meta.remove();
		};
	}, []);

	return (
		<div className="flex h-dvh flex-col">
			<PageTitle>{app.title}</PageTitle>
			<header className="flex min-h-12 items-center gap-3 border-b px-4">
				<Brand size="sm" />
				<span className="text-border" aria-hidden="true">
					/
				</span>
				<h1 className="min-w-0 flex-1 truncate text-sm font-medium">{app.title}</h1>
				<IconButton
					label="Copy app link"
					onPress={() =>
						void copy(window.location.href).then(
							(copied) => copied && toast.success('App link copied'),
						)
					}
				>
					<Copy className="size-4" />
				</IconButton>
				{!isSignedIn && (
					<Button variant="ghost" size="sm" onPress={signIn}>
						Sign in
					</Button>
				)}
			</header>
			{ended === 'revoked' ? (
				<div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
					<h2 className="text-base font-semibold">This app is no longer publicly available</h2>
					<p className="text-sm text-muted-foreground">
						Public access was turned off for this link.
					</p>
					{!isSignedIn && <Button onPress={signIn}>Sign in</Button>}
				</div>
			) : error || ended ? (
				<div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
					<p className="text-sm text-muted-foreground">
						{error?.code === 'RESOURCE_EXHAUSTED'
							? 'This app is currently busy. Try again shortly.'
							: error
								? error.message
								: 'This app session has ended.'}
					</p>
					<Button onPress={start}>{error ? 'Retry' : 'Open app'}</Button>
				</div>
			) : isProvisioning || !src ? (
				<output className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
					Starting app…
				</output>
			) : (
				<div className="min-h-0 flex-1">
					<NotebookFrame
						key={frameKey}
						src={src}
						retrySrc={latestSrc}
						sandboxUrl={sandboxUrl ?? undefined}
						onQuery={onQuery}
						title={app.title}
					/>
				</div>
			)}
		</div>
	);
}
