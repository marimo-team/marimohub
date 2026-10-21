import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { UploadProgressList } from './UploadProgressList';

it('announces phase changes without announcing each percentage change', () => {
	const upload = { path: 'data.csv', phase: 'uploading' as const, loaded: 10, total: 100 };
	const { rerender } = render(<UploadProgressList uploads={{ active: upload }} />);
	expect(screen.getByRole('status')).toHaveTextContent('data.csv: Uploading');
	expect(screen.getByText('10%').closest('[aria-live], output')).toBeNull();
	rerender(<UploadProgressList uploads={{ active: { ...upload, loaded: 20 } }} />);
	expect(screen.getByRole('status')).toHaveTextContent('data.csv: Uploading');
	expect(screen.getByText('20%')).toBeInTheDocument();
	rerender(
		<UploadProgressList uploads={{ active: { ...upload, phase: 'publishing', loaded: 100 } }} />,
	);
	expect(screen.getByRole('status')).toHaveTextContent('data.csv: Saving');
});
