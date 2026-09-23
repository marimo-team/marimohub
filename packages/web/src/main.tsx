import { BrandingContext } from '@/context/BrandingContext';
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
	applyThemeMode(getInitialTheme());
	const branding = await loadThemeConfig();
	applyThemeConfig(branding);
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
