import { BrandingContext } from '@/context/BrandingContext';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { applyThemeConfig, applyThemeMode, getInitialTheme, loadThemeConfig } from '@/lib/theme';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App.tsx';
import { queryClient } from './api/queryClient';

// Dev-only: the React Query devtools are loaded via a dynamic import gated on
// `import.meta.env.DEV`, so the production build tree-shakes the module out
// entirely (it ships nothing to users instead of a render-nothing component).
const ReactQueryDevtools = import.meta.env.DEV
	? lazy(() =>
			import('@tanstack/react-query-devtools').then((m) => ({
				default: m.ReactQueryDevtools,
			})),
		)
	: () => null;

async function bootstrap() {
	let branding = DEFAULT_THEME_CONFIG;
	try {
		applyThemeMode(getInitialTheme());
		const config = await loadThemeConfig();
		applyThemeConfig(config);
		branding = config;
	} catch (error) {
		console.warn('Could not initialize the deployment theme. Using defaults.', error);
	}
	createRoot(document.getElementById('root')!).render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<BrandingContext value={branding}>
					<App />
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
