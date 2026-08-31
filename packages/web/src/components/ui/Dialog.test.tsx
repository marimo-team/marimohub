import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DialogModal } from './Dialog';

describe('DialogModal', () => {
	it('gives the inner dialog a definite height for the screen variant', () => {
		render(
			<DialogModal isOpen onClose={vi.fn()} width="screen" title="Workspace">
				<div>Browser</div>
			</DialogModal>,
		);

		expect(screen.getByRole('dialog')).toHaveClass('h-full');
	});

	it('does not force full height on content-sized variants', () => {
		render(
			<DialogModal isOpen onClose={vi.fn()} width="md" title="Settings">
				<div>Content</div>
			</DialogModal>,
		);

		expect(screen.getByRole('dialog')).not.toHaveClass('h-full');
	});
});
