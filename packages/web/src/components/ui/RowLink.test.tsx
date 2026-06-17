import type { ReactNode } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RowLink } from './RowLink';

function renderRow(ui: ReactNode) {
	return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('RowLink', () => {
	it('renders a real anchor pointing at `to` (so cmd/middle-click can open a new tab)', () => {
		renderRow(
			<RowLink to="/projects/p1" label="Open project">
				<span>Project One</span>
			</RowLink>,
		);
		const link = screen.getByRole('link', { name: 'Open project' });
		expect(link).toHaveAttribute('href', '/projects/p1');
	});

	it('renders actions OUTSIDE the anchor (valid HTML — no interactive nesting)', () => {
		renderRow(
			<RowLink to="/x" label="Row" actions={<button type="button">Act</button>}>
				<span>content</span>
			</RowLink>,
		);
		const link = screen.getByRole('link', { name: 'Row' });
		const action = screen.getByRole('button', { name: 'Act' });
		expect(link).not.toContainElement(action);
	});

	it('forwards testId to the row container', () => {
		renderRow(
			<RowLink to="/x" testId="my-row">
				<span>x</span>
			</RowLink>,
		);
		expect(screen.getByTestId('my-row')).toBeInTheDocument();
	});
});
