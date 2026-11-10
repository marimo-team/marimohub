import { BrandingContext } from '@/context/BrandingContext';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { applyThemeConfig, applyThemeMode, getInitialTheme, loadThemeConfig } from '@/lib/theme';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App.tsx';
import { preloadInitialRoute } from './lib/initialRoute';
import { queryClient } from './api/queryClient';
import { capabilitiesQueryOptions, userQueryOptions } from './api/hooks';

// The DEV guard keeps query devtools out of production bundles.
const ReactQueryDevtools = import.meta.env.DEV
	? lazy(() =>
			import('@tanstack/react-query-devtools').then((m) => ({
				default: m.ReactQueryDevtools,
			})),
		)
	: () => null;

async function bootstrap() {
	const initialRoute = preloadInitialRoute(queryClient).catch(() => ({}));
	// Hooks reuse these requests while the theme and route load.
	void queryClient.prefetchQuery(userQueryOptions());
	void queryClient.prefetchQuery(capabilitiesQueryOptions());
	// Apply the saved mode before the theme request to avoid a light-mode flash.
	try {
		applyThemeMode(getInitialTheme());
	} catch (error) {
		console.warn('Could not apply the preferred color mode.', error);
	}
	let branding = DEFAULT_THEME_CONFIG;
	try {
		branding = await loadThemeConfig();
	} catch (error) {
		console.warn('Could not load the deployment theme. Using defaults.', error);
	}
	try {
		if (branding.color_mode !== 'user') applyThemeMode(branding.color_mode);
		applyThemeConfig(branding);
	} catch (error) {
		console.warn('Could not fully initialize the deployment theme.', error);
	}
	const initialRoutes = await initialRoute;
	createRoot(document.getElementById('root')!).render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<BrandingContext value={branding}>
					<App initialRoutes={initialRoutes} />
				</BrandingContext>
				{import.meta.env.DEV && (
					<Suspense fallback={null}>
						<ReactQueryDevtools initialIsOpen={false} />
					</Suspense>
				)}
			</QueryClientProvider>
		</StrictMode>,
	);
}

void bootstrap();
