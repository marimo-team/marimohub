import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StatusDot } from './StatusDot';

describe('StatusDot', () => {
	it('applies the color class', () => {
		const { container } = render(<StatusDot className="bg-green-500" />);
		expect(container.firstChild).toHaveClass('bg-green-500');
	});

	it('adds the pulse animation only when pulse is set', () => {
		const { container, rerender } = render(<StatusDot className="bg-amber-500" pulse />);
		expect(container.firstChild).toHaveClass('animate-pulse');

		rerender(<StatusDot className="bg-green-500" />);
		expect(container.firstChild).not.toHaveClass('animate-pulse');
	});
});
