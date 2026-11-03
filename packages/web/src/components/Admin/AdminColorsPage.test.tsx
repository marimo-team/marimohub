import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { generateThemePalette } from '@marimo-hub/core/theme-palette';
import { renderWithClient } from '@/test/render';
import AdminColorsPage from './AdminColorsPage';

const BRAND = { primary_color: '#2741E7', secondary_color: '#000000' };

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
		for (const [token, light] of Object.entries(palette.light)) {
			const cells = within(tokenRow(token)).getAllByRole('cell');
			expect(cells[0]).toHaveTextContent('Preview only');
			expect(cells[1]).toHaveTextContent(light);
			expect(cells[2]).toHaveTextContent(palette.dark[token]);
			expect(cells[1]).toHaveStyle({ backgroundColor: palette.light.background });
			expect(cells[2]).toHaveStyle({ backgroundColor: palette.dark.background });
			expect(cells[1].querySelector('[aria-hidden]')).toHaveStyle({ backgroundColor: light });
			expect(cells[2].querySelector('[aria-hidden]')).toHaveStyle({
				backgroundColor: palette.dark[token],
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

	it('shows an unapplied reference palette when no brand colors are configured', () => {
		renderWithClient(<AdminColorsPage />, { branding: { notebook_palette: 'full' } });
		expect(screen.getAllByText('Not set')).toHaveLength(2);
		expect(screen.getByText(/No brand colors are configured/)).toBeVisible();
		expect(screen.queryByText('Applied')).not.toBeInTheDocument();
		expect(within(tokenRow('primary')).getByText('Preview only')).toBeVisible();
	});

	it('shows the inherited secondary seed without presenting it as a configured color', () => {
		renderWithClient(<AdminColorsPage />, { branding: { primary_color: '#2741E7' } });
		expect(screen.getByText('Not set')).toBeVisible();
		expect(
			screen.getByText('Follows the primary color when a palette is generated.'),
		).toBeVisible();
	});
});
