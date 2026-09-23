import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import type { ThemeConfig } from '@marimo-hub/core/theme';
import { BrandingContext } from '@/context/BrandingContext';
import { ThemeProvider, useTheme } from '@/context/ThemeContext';
import { installMatchMedia } from '@/test/render';
import { Brand } from './Brand';
import { PageTitle } from './PageTitle';

function ModeToggle() {
	const { toggleTheme } = useTheme();
	return <button onClick={toggleTheme}>Toggle</button>;
}

function BrandFixture({ config }: { config: Partial<ThemeConfig> }) {
	return (
		<BrandingContext value={{ ...DEFAULT_THEME_CONFIG, ...config }}>
			<ThemeProvider>
				<Brand builtInWordmarkClassName="max-md:hidden" />
				<PageTitle>Projects</PageTitle>
				<ModeToggle />
			</ThemeProvider>
		</BrandingContext>
	);
}

function renderBrand(config: Partial<ThemeConfig> = {}) {
	return render(<BrandFixture config={config} />);
}

beforeEach(() => {
	installMatchMedia(false);
	localStorage.clear();
});
afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
	document.documentElement.classList.remove('dark');
});

describe('deployment branding', () => {
	it('preserves stock wordmark and page titles', () => {
		renderBrand();
		expect(screen.getByText('MARIMOHUB')).toHaveClass('max-md:hidden');
		expect(document.title).toBe('Projects · marimohub');
	});

	it('uses the deployment name as text and title without treating it as HTML', () => {
		renderBrand({ name: 'Research <Hub>' });
		expect(screen.getByText('Research <Hub>')).toBeInTheDocument();
		expect(document.title).toBe('Projects · Research <Hub>');
	});

	it('replaces the whole lockup and switches logos with mode', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		renderBrand({ name: 'Research Hub', logo: '/logo.svg', logo_dark: '/logo-dark.png' });
		expect(screen.getByRole('img', { name: 'Research Hub' })).toHaveAttribute('src', '/logo.svg');
		expect(screen.queryByText('MARIMOHUB')).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
		expect(screen.getByRole('img')).toHaveAttribute('src', '/logo-dark.png');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('keeps custom logos visible on mobile and applies wordmark classes to the fallback', () => {
		renderBrand({ name: 'Research Hub', logo: '/logo.svg' });
		const logo = screen.getByRole('img', { name: 'Research Hub' });
		expect(logo).toHaveClass('h-7', 'max-w-36', 'max-md:max-w-28');
		expect(logo).not.toHaveClass('max-md:hidden');
		fireEvent.error(logo);
		expect(screen.getByText('Research Hub')).toHaveClass('max-md:hidden');
	});

	it('falls back from failed dark logo to main logo to built-in identity', async () => {
		localStorage.setItem('marimohub-theme', 'dark');
		renderBrand({ name: 'Research Hub', logo: '/logo.svg', logo_dark: '/logo-dark.svg' });
		fireEvent.error(screen.getByRole('img'));
		expect(screen.getByRole('img')).toHaveAttribute('src', '/logo.svg');
		fireEvent.error(screen.getByRole('img'));
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
		expect(screen.getByText('Research Hub')).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
	});

	it('reuses the main logo in dark mode when no dark logo is configured', () => {
		localStorage.setItem('marimohub-theme', 'dark');
		renderBrand({ logo: '/logo.svg' });
		expect(screen.getByRole('img')).toHaveAttribute('src', '/logo.svg');
	});
	it('supports a dark-only logo and restores it after returning from light mode', async () => {
		renderBrand({ name: 'Research Hub', logo_dark: '/dark.svg' });
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
		expect(screen.getByText('Research Hub')).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
		expect(screen.getByRole('img')).toHaveAttribute('src', '/dark.svg');
		await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
		expect(screen.getByRole('img')).toHaveAttribute('src', '/dark.svg');
	});

	it('does not retry a failed shared logo URL when switching modes', async () => {
		renderBrand({ name: 'Research Hub', logo: '/shared.svg', logo_dark: '/shared.svg' });
		fireEvent.error(screen.getByRole('img'));
		for (let index = 0; index < 3; index++) {
			await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
			expect(screen.queryByRole('img')).not.toBeInTheDocument();
			expect(screen.getByText('Research Hub')).toBeInTheDocument();
		}
	});

	it('can still show the dark logo after the light logo fails', async () => {
		renderBrand({ name: 'Research Hub', logo: '/broken.svg', logo_dark: '/dark.svg' });
		fireEvent.error(screen.getByRole('img'));
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
		expect(screen.getByRole('img')).toHaveAttribute('src', '/dark.svg');
		await userEvent.click(screen.getByRole('button', { name: 'Toggle' }));
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
	});

	it('recovers from failed images when a new logo URL is provided', () => {
		const { rerender } = renderBrand({ logo: '/broken.svg' });
		fireEvent.error(screen.getByRole('img'));
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
		rerender(<BrandFixture config={{ name: 'New hub', logo: '/replacement.png' }} />);
		expect(screen.getByRole('img', { name: 'New hub' })).toHaveAttribute('src', '/replacement.png');
		expect(document.title).toBe('Projects · New hub');
	});
});
