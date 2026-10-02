import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installMatchMedia, renderWithClient } from '@/test/render';
import { THEME_STORAGE_KEY as STORAGE_KEY } from '@/lib/theme';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { BrandingContext } from './BrandingContext';
import { ThemeProvider, useTheme } from './ThemeContext';
import type { Theme } from './ThemeContext';

function Probe() {
	const { theme, isThemeForced, toggleTheme, setTheme } = useTheme();
	return (
		<div>
			<span data-testid="theme">{theme}</span>
			<span data-testid="forced">{String(isThemeForced)}</span>
			<button type="button" onClick={toggleTheme}>
				Toggle
			</button>
			<button type="button" onClick={() => setTheme('dark')}>
				Go dark
			</button>
			<button type="button" onClick={() => setTheme('light')}>
				Go light
			</button>
		</div>
	);
}

function renderTheme(forceMode: Theme | null = null) {
	return renderWithClient(
		<BrandingContext value={{ ...DEFAULT_THEME_CONFIG, force_mode: forceMode }}>
			<ThemeProvider>
				<Probe />
			</ThemeProvider>
		</BrandingContext>,
		{ toaster: false },
	);
}

const isDarkClassOn = () => document.documentElement.classList.contains('dark');

beforeEach(() => {
	localStorage.clear();
	installMatchMedia(false);
});

afterEach(() => {
	localStorage.clear();
	document.documentElement.classList.remove('dark');
	document.documentElement.style.removeProperty('color-scheme');
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('useTheme', () => {
	it('throws when rendered outside a ThemeProvider', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(() => renderWithClient(<Probe />, { toaster: false })).toThrow(
			'useTheme must be used within a ThemeProvider',
		);
	});
});

describe('ThemeProvider', () => {
	it.each<Theme>(['light', 'dark'])(
		'enforces %s and restores the saved preference when removed',
		async (forced) => {
			const user = userEvent.setup();
			const preferred = forced === 'light' ? 'dark' : 'light';
			localStorage.setItem(STORAGE_KEY, preferred);
			installMatchMedia(preferred === 'dark');
			const store = vi.spyOn(Storage.prototype, 'setItem');

			const { unmount } = renderTheme(forced);
			expect(screen.getByTestId('theme')).toHaveTextContent(forced);
			expect(isDarkClassOn()).toBe(forced === 'dark');
			expect(document.documentElement.style.colorScheme).toBe(forced);

			await user.click(screen.getByRole('button', { name: 'Toggle' }));
			await user.click(screen.getByRole('button', { name: 'Go dark' }));
			await user.click(screen.getByRole('button', { name: 'Go light' }));
			expect(screen.getByTestId('theme')).toHaveTextContent(forced);
			expect(store).not.toHaveBeenCalled();
			expect(localStorage.getItem(STORAGE_KEY)).toBe(preferred);

			unmount();
			renderTheme();
			expect(screen.getByTestId('theme')).toHaveTextContent(preferred);
			expect(screen.getByTestId('forced')).toHaveTextContent('false');
			await user.click(screen.getByRole('button', { name: 'Toggle' }));
			expect(screen.getByTestId('theme')).toHaveTextContent(forced);
			expect(localStorage.getItem(STORAGE_KEY)).toBe(forced);
		},
	);

	it.each<Theme>(['light', 'dark'])('enforces %s when browser preference APIs fail', (forced) => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new DOMException('Storage blocked', 'SecurityError');
		});
		const store = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('Storage blocked', 'SecurityError');
		});
		vi.stubGlobal('matchMedia', () => {
			throw new Error('Unavailable');
		});

		renderTheme(forced);
		expect(screen.getByTestId('theme')).toHaveTextContent(forced);
		expect(screen.getByTestId('forced')).toHaveTextContent('true');
		expect(isDarkClassOn()).toBe(forced === 'dark');
		expect(document.documentElement.style.colorScheme).toBe(forced);
		expect(store).not.toHaveBeenCalled();
	});

	it.each([null, 'invalid'])(
		'does not save forced mode over an absent or invalid preference (%s)',
		(stored) => {
			if (stored !== null) localStorage.setItem(STORAGE_KEY, stored);
			installMatchMedia(true);
			const { unmount } = renderTheme('light');
			expect(screen.getByTestId('theme')).toHaveTextContent('light');
			expect(localStorage.getItem(STORAGE_KEY)).toBe(stored);

			unmount();
			renderTheme();
			expect(screen.getByTestId('theme')).toHaveTextContent('dark');
			expect(screen.getByTestId('forced')).toHaveTextContent('false');
		},
	);

	it.each<Theme>(['light', 'dark'])('starts from the stored %s theme', (stored) => {
		localStorage.setItem(STORAGE_KEY, stored);
		// The stored value wins over a conflicting system preference.
		installMatchMedia(stored === 'light');

		renderTheme();

		expect(screen.getByTestId('theme')).toHaveTextContent(stored);
		expect(isDarkClassOn()).toBe(stored === 'dark');
	});

	it('falls back to the system preference when storage is empty', () => {
		installMatchMedia(true);

		renderTheme();

		expect(screen.getByTestId('theme')).toHaveTextContent('dark');
	});

	it('falls back to light when storage is empty and the system prefers light', () => {
		installMatchMedia(false);

		renderTheme();

		expect(screen.getByTestId('theme')).toHaveTextContent('light');
	});

	it('ignores a garbage stored value and uses the system preference', () => {
		localStorage.setItem(STORAGE_KEY, 'chartreuse');
		installMatchMedia(true);

		renderTheme();

		expect(screen.getByTestId('theme')).toHaveTextContent('dark');
	});

	it('adds the dark class for dark and removes it for light', async () => {
		const user = userEvent.setup();
		localStorage.setItem(STORAGE_KEY, 'dark');

		renderTheme();
		expect(isDarkClassOn()).toBe(true);

		await user.click(screen.getByRole('button', { name: 'Go light' }));
		expect(isDarkClassOn()).toBe(false);
	});

	it.each([
		undefined,
		() => {
			throw new Error('System preference unavailable');
		},
	])('uses light mode when the system preference is unavailable (%#)', (matchMedia) => {
		vi.stubGlobal('matchMedia', matchMedia);
		renderTheme();
		expect(screen.getByTestId('theme')).toHaveTextContent('light');
		expect(isDarkClassOn()).toBe(false);
	});

	it('persists the theme to localStorage on mount and on every change', async () => {
		const user = userEvent.setup();

		renderTheme();
		expect(localStorage.getItem(STORAGE_KEY)).toBe('light');

		await user.click(screen.getByRole('button', { name: 'Go dark' }));
		expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
	});

	it('toggleTheme flips between light and dark', async () => {
		const user = userEvent.setup();

		renderTheme();
		expect(screen.getByTestId('theme')).toHaveTextContent('light');

		await user.click(screen.getByRole('button', { name: 'Toggle' }));
		expect(screen.getByTestId('theme')).toHaveTextContent('dark');

		await user.click(screen.getByRole('button', { name: 'Toggle' }));
		expect(screen.getByTestId('theme')).toHaveTextContent('light');
	});

	it('setTheme sets the theme directly', async () => {
		const user = userEvent.setup();

		renderTheme();

		await user.click(screen.getByRole('button', { name: 'Go dark' }));
		expect(screen.getByTestId('theme')).toHaveTextContent('dark');
		expect(isDarkClassOn()).toBe(true);

		await user.click(screen.getByRole('button', { name: 'Go dark' }));
		expect(screen.getByTestId('theme')).toHaveTextContent('dark');
	});
	it('keeps mode switching usable when browser storage rejects writes', async () => {
		const user = userEvent.setup();
		const store = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('Quota exceeded', 'QuotaExceededError');
		});
		renderTheme();
		await user.click(screen.getByRole('button', { name: 'Toggle' }));
		expect(screen.getByTestId('theme')).toHaveTextContent('dark');
		expect(isDarkClassOn()).toBe(true);
		expect(document.documentElement.style.colorScheme).toBe('dark');
		await user.click(screen.getByRole('button', { name: 'Toggle' }));
		expect(isDarkClassOn()).toBe(false);
		expect(store).toHaveBeenLastCalledWith(STORAGE_KEY, 'light');
	});
});
