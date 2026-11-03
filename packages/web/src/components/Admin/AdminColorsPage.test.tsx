import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { generateThemePalette } from '@marimo-hub/core/theme-palette';
import { BrandingContext } from '@/context/BrandingContext';
import { renderWithClient } from '@/test/render';
import AdminColorsPage from './AdminColorsPage';

const BRAND = { primary_color: '#2741E7', secondary_color: '#000000' };

afterEach(() => vi.restoreAllMocks());

function tokenRow(token: string) {
	return screen.getByRole('rowheader', { name: `--${token}` }).closest('tr')!;
}

describe('AdminColorsPage', () => {
	it('shows configured colors and all light and dark tokens while notebook branding is off', () => {
		renderWithClient(<AdminColorsPage />, { branding: BRAND });
		expect(screen.getByText('#2741E7')).toBeVisible();
		expect(screen.getByText('off', { exact: true })).toBeVisible();
		expect(
			screen.getByText('Native marimo colors. No generated tokens are applied.'),
		).toBeVisible();
		const palette = generateThemePalette(BRAND)!;
		for (const token of [...Object.keys(palette.light), 'link', 'link-visited']) {
			const source = token === 'link' || token === 'link-visited' ? 'primary' : token;
			const light = palette.light[source];
			const dark = palette.dark[source];
			const cells = within(tokenRow(token)).getAllByRole('cell');
			expect(cells[0]).toHaveTextContent('Preview only');
			expect(cells[1]).toHaveTextContent(light);
			expect(cells[2]).toHaveTextContent(dark);
			expect(cells[1]).toHaveStyle({ backgroundColor: palette.light.background });
			expect(cells[2]).toHaveStyle({ backgroundColor: palette.dark.background });
			expect(cells[1].querySelector('[aria-hidden]')).toHaveStyle({ backgroundColor: light });
			expect(cells[2].querySelector('[aria-hidden]')).toHaveStyle({
				backgroundColor: dark,
			});
		}
	});

	it('marks only action, link, and focus tokens as applied in accents mode', () => {
		renderWithClient(<AdminColorsPage />, { branding: { ...BRAND, notebook_palette: 'accents' } });
		for (const token of [
			'primary',
			'primary-foreground',
			'ring',
			'link',
			'link-visited',
			'sidebar-primary',
		]) {
			expect(within(tokenRow(token)).getByText('Applied')).toBeVisible();
		}
		for (const token of ['background', 'foreground', 'secondary', 'chart-1', 'sidebar']) {
			expect(within(tokenRow(token)).getByText('Preview only')).toBeVisible();
		}
	});

	it('marks the full palette as applied', () => {
		renderWithClient(<AdminColorsPage />, { branding: { ...BRAND, notebook_palette: 'full' } });
		expect(screen.queryByText('Preview only')).not.toBeInTheDocument();
		expect(within(tokenRow('background')).getByText('Applied')).toBeVisible();
		expect(within(tokenRow('chart-5')).getByText('Applied')).toBeVisible();
	});

	it.each(['off', 'accents', 'full'] as const)(
		'shows an unapplied reference palette with no brand colors in %s mode',
		(mode) => {
			renderWithClient(<AdminColorsPage />, { branding: { notebook_palette: mode } });
			expect(screen.getAllByText('Not set')).toHaveLength(2);
			expect(screen.getByText(/No brand colors are configured/)).toBeVisible();
			expect(screen.queryByText('Applied')).not.toBeInTheDocument();
			expect(within(tokenRow('primary')).getByText('Preview only')).toBeVisible();
		},
	);

	it('shows the inherited secondary seed without presenting it as a configured color', () => {
		renderWithClient(<AdminColorsPage />, { branding: { primary_color: '#2741E7' } });
		expect(screen.getByText('Not set')).toBeVisible();
		expect(
			screen.getByText('Follows the primary color when a palette is generated.'),
		).toBeVisible();
	});

	it('uses fallback primary colors when only the secondary seed is configured', () => {
		const branding = {
			secondary_color: '#F00',
			primary_color: null,
			notebook_palette: 'accents' as const,
		};
		renderWithClient(<AdminColorsPage />, { branding });
		expect(screen.getByText('Not set')).toBeVisible();
		expect(screen.getByText('#F00')).toBeVisible();
		expect(screen.getByText('Uses the default teal when a palette is generated.')).toBeVisible();
		expect(screen.queryByText(/No brand colors are configured/)).not.toBeInTheDocument();
		const palette = generateThemePalette(branding)!;
		const cells = within(tokenRow('primary')).getAllByRole('cell');
		expect(cells[0]).toHaveTextContent('Applied');
		expect(cells[1]).toHaveTextContent(palette.light.primary);
		expect(cells[2]).toHaveTextContent(palette.dark.primary);
		expect(within(tokenRow('secondary')).getByText('Preview only')).toBeVisible();
	});

	it('updates applied tokens and swatches when branding changes without remounting', () => {
		const renderPage = (notebook_palette: 'off' | 'accents' | 'full', colors = BRAND) => (
			<BrandingContext value={{ ...DEFAULT_THEME_CONFIG, ...colors, notebook_palette }}>
				<AdminColorsPage />
			</BrandingContext>
		);
		const { rerender } = renderWithClient(renderPage('full'));
		expect(within(tokenRow('background')).getByText('Applied')).toBeVisible();
		rerender(renderPage('accents'));
		expect(within(tokenRow('background')).getByText('Preview only')).toBeVisible();
		expect(within(tokenRow('primary')).getByText('Applied')).toBeVisible();
		const colors = { primary_color: '#F00', secondary_color: '#FFF' };
		rerender(renderPage('off', colors));
		expect(screen.queryByText('Applied')).not.toBeInTheDocument();
		const cells = within(tokenRow('primary')).getAllByRole('cell');
		const palette = generateThemePalette(colors)!;
		expect(cells[1]).toHaveTextContent(palette.light.primary);
		expect(cells[2]).toHaveTextContent(palette.dark.primary);
		expect(screen.queryByText('#2741E7')).not.toBeInTheDocument();
	});

	it('keeps the reference available without loading custom notebook CSS', () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('CSS unavailable'));
		renderWithClient(<AdminColorsPage />, {
			branding: {
				...BRAND,
				notebook_palette: 'full',
				notebook_css: 'https://unavailable.example/brand.css',
			},
		});
		expect(screen.getByRole('table')).toBeVisible();
		expect(screen.getByText(/Custom CSS can override them/)).toBeVisible();
		expect(within(tokenRow('primary')).getByText('Applied')).toBeVisible();
		expect(fetch).not.toHaveBeenCalled();
	});
});
