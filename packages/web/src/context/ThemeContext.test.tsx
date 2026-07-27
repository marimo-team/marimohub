import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installMatchMedia, renderWithClient } from '@/test/render';
import { ThemeProvider, useTheme } from './ThemeContext';
import type { Theme } from './ThemeContext';

const STORAGE_KEY = 'marimohub-theme';

function Probe() {
	const { theme, toggleTheme, setTheme } = useTheme();
	return (
		<div>
			<span data-testid="theme">{theme}</span>
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

function renderTheme() {
	return renderWithClient(
		<ThemeProvider>
			<Probe />
		</ThemeProvider>,
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
});
