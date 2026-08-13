import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TabularPreviewGrid } from './TabularPreviewGrid';

describe('TabularPreviewGrid', () => {
	it('renders bigint and unserializable values without using them as raw JSON keys', () => {
		const circular: { self?: unknown } = {};
		circular.self = circular;

		render(
			<TabularPreviewGrid columns={['value']} rows={[[123n], [circular], [123n]]} truncated />,
		);

		expect(screen.getAllByText('123')).toHaveLength(2);
		expect(screen.getByText('[unserializable]')).toBeInTheDocument();
		expect(screen.getByText('Preview truncated.')).toBeInTheDocument();
	});

	it('serializes object cells once per render', () => {
		const toJSON = vi.fn(() => ({ value: 'large' }));

		render(<TabularPreviewGrid columns={['value']} rows={[[{ toJSON }]]} />);

		expect(screen.getByText('{"value":"large"}')).toBeInTheDocument();
		expect(toJSON).toHaveBeenCalledOnce();
	});
});
