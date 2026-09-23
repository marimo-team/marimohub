import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';

const theme = vi.hoisted(() => ({
	getInitialTheme: vi.fn(() => 'dark'),
	applyThemeMode: vi.fn(),
	loadThemeConfig: vi.fn(),
	applyThemeConfig: vi.fn(),
}));
const render = vi.hoisted(() => vi.fn());

vi.mock('@/lib/theme', () => theme);
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render }) }));
vi.mock('@tanstack/react-query-devtools', () => ({ ReactQueryDevtools: () => null }));
vi.mock('./App.tsx', async () => {
	const { useBranding } = await import('./context/BrandingContext');
	function App() {
		return <div>{useBranding().name}</div>;
	}
	return { default: App };
});

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	theme.loadThemeConfig.mockResolvedValue(DEFAULT_THEME_CONFIG);
	document.body.innerHTML = '<div id="root"></div>';
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

describe('app bootstrap', () => {
	it('applies branding before the first render', async () => {
		const config = { ...DEFAULT_THEME_CONFIG, name: 'Research Hub', primary_color: '#123456' };
		let resolve!: (value: typeof config) => void;
		theme.loadThemeConfig.mockReturnValue(
			new Promise((complete) => {
				resolve = complete;
			}),
		);
		await import('./main');
		expect(render).not.toHaveBeenCalled();
		expect(theme.applyThemeMode).toHaveBeenCalledWith('dark');
		resolve(config);
		await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
		expect(theme.applyThemeConfig).toHaveBeenCalledExactlyOnceWith(config);
		expect(theme.applyThemeConfig).toHaveBeenCalledBefore(render);
		expect(renderToStaticMarkup(render.mock.calls[0][0])).toContain('Research Hub');
	});

	it.each(['getInitialTheme', 'applyThemeMode', 'loadThemeConfig', 'applyThemeConfig'] as const)(
		'renders defaults when %s fails unexpectedly',
		async (operation) => {
			const error = new Error('Theme initialization failed');
			theme.loadThemeConfig.mockResolvedValue({ ...DEFAULT_THEME_CONFIG, name: 'Research Hub' });
			if (operation === 'loadThemeConfig') {
				theme.loadThemeConfig.mockRejectedValueOnce(error);
			} else {
				theme[operation].mockImplementationOnce(() => {
					throw error;
				});
			}
			await import('./main');
			await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
			expect(renderToStaticMarkup(render.mock.calls[0][0])).toContain('marimohub');
			expect(console.warn).toHaveBeenCalledWith(
				'Could not initialize the deployment theme. Using defaults.',
				error,
			);
		},
	);
});
