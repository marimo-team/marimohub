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

beforeEach(() => {
	vi.resetModules();
	vi.doMock('./App.tsx', async () => {
		const { useBranding } = await import('./context/BrandingContext');
		function App() {
			const branding = useBranding();
			return (
				<div>
					{branding.name}:{branding.color_mode}
				</div>
			);
		}
		return { default: App };
	});
	vi.resetAllMocks();
	theme.getInitialTheme.mockReturnValue('dark');
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
		expect(theme.applyThemeMode).toHaveBeenCalledExactlyOnceWith('dark');
		expect(theme.applyThemeMode).toHaveBeenCalledBefore(theme.loadThemeConfig);
		resolve(config);
		await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
		expect(theme.applyThemeConfig).toHaveBeenCalledExactlyOnceWith(config);
		expect(theme.applyThemeConfig).toHaveBeenCalledBefore(render);
		expect(theme.applyThemeMode).toHaveBeenCalledExactlyOnceWith('dark');
		expect(renderToStaticMarkup(render.mock.calls[0][0])).toContain('Research Hub');
	});

	it.each([
		['light', 'dark'],
		['dark', 'light'],
	] as const)(
		'overrides the preferred mode with the %s color mode before rendering',
		async (mode, preferred) => {
			theme.getInitialTheme.mockReturnValue(preferred);
			theme.loadThemeConfig.mockResolvedValue({ ...DEFAULT_THEME_CONFIG, color_mode: mode });
			await import('./main');
			await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
			expect(theme.applyThemeMode.mock.calls).toEqual([[preferred], [mode]]);
			expect(theme.applyThemeMode).toHaveBeenCalledBefore(theme.loadThemeConfig);
			expect(theme.applyThemeMode).toHaveBeenCalledBefore(render);
		},
	);

	it('preserves the forced color mode when applying branding fails', async () => {
		theme.loadThemeConfig.mockResolvedValue({ ...DEFAULT_THEME_CONFIG, color_mode: 'light' });
		theme.applyThemeConfig.mockImplementationOnce(() => {
			throw new Error('Branding failed');
		});
		await import('./main');
		await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
		expect(renderToStaticMarkup(render.mock.calls[0][0])).toContain('marimohub:light');
		expect(theme.applyThemeMode).toHaveBeenLastCalledWith('light');
	});

	it.each(['light', 'dark'] as const)(
		'applies the preferred %s mode before rendering when configuration loading throws',
		async (mode) => {
			const error = new Error('Theme configuration unavailable');
			theme.loadThemeConfig.mockRejectedValueOnce(error);
			theme.getInitialTheme.mockReturnValueOnce(mode);
			await import('./main');
			await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
			expect(theme.applyThemeMode).toHaveBeenCalledExactlyOnceWith(mode);
			expect(theme.applyThemeMode).toHaveBeenCalledBefore(render);
			expect(renderToStaticMarkup(render.mock.calls[0][0])).toContain('marimohub:user');
			expect(console.warn).toHaveBeenCalledWith(
				'Could not load the deployment theme. Using defaults.',
				error,
			);
		},
	);

	it.each(['getInitialTheme', 'applyThemeMode'] as const)(
		'still loads the deployment theme when %s fails unexpectedly',
		async (operation) => {
			const error = new Error('Preferred mode failed');
			theme.loadThemeConfig.mockResolvedValue({ ...DEFAULT_THEME_CONFIG, name: 'Research Hub' });
			theme[operation].mockImplementationOnce(() => {
				throw error;
			});
			await import('./main');
			await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
			expect(theme.applyThemeConfig).toHaveBeenCalledOnce();
			expect(renderToStaticMarkup(render.mock.calls[0][0])).toContain('Research Hub:user');
			expect(console.warn).toHaveBeenCalledWith('Could not apply the preferred color mode.', error);
		},
	);

	it.each([
		['applyThemeMode', 'dark'],
		['applyThemeConfig', 'user'],
	] as const)(
		'renders with the available configuration when %s fails after loading',
		async (operation, color_mode) => {
			const error = new Error('Theme initialization failed');
			theme.loadThemeConfig.mockResolvedValue({
				...DEFAULT_THEME_CONFIG,
				name: 'Research Hub',
				color_mode,
			});
			if (operation === 'applyThemeMode') {
				theme.applyThemeMode
					.mockImplementationOnce(() => {})
					.mockImplementationOnce(() => {
						throw error;
					});
			} else {
				theme.applyThemeConfig.mockImplementationOnce(() => {
					throw error;
				});
			}
			await import('./main');
			await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
			expect(renderToStaticMarkup(render.mock.calls[0][0])).toContain(`Research Hub:${color_mode}`);
			expect(console.warn).toHaveBeenCalledWith(
				'Could not fully initialize the deployment theme.',
				error,
			);
		},
	);
});
