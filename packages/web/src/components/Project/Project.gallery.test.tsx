import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { makeFetch, renderProject } from './Project.testWorld';

afterEach(() => localStorage.removeItem('notebook-view'));
describe('notebook gallery', () => {
	it('defaults to a list and remembers the gallery selection', async () => {
		makeFetch();
		const user = userEvent.setup();
		await renderProject();
		expect(await screen.findByRole('button', { name: 'List' })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		await user.click(screen.getByRole('button', { name: 'Gallery' }));
		expect(screen.getByRole('button', { name: 'Gallery' })).toHaveAttribute('aria-pressed', 'true');
		expect(localStorage.getItem('notebook-view')).toBe('gallery');
		cleanup();
		await renderProject();
		expect(screen.getByRole('button', { name: 'Gallery' })).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByRole('link', { name: 'Forecast' })).toHaveAttribute(
			'href',
			'/projects/proj-x/notebooks/nb-1',
		);
	});
});
