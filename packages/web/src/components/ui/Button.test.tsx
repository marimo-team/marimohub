import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
	it('transitions the disabled opacity change', () => {
		render(<Button isDisabled>Save</Button>);

		expect(screen.getByRole('button', { name: 'Save' })).toHaveClass(
			'transition-[color,background-color,border-color,box-shadow,transform,opacity]',
		);
	});
});
