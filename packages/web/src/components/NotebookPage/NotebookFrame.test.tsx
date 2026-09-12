import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotebookFrame } from './NotebookFrame';

const SRC = 'https://kernel.example/?access_token=test-token&theme=dark';
const frame = (src: string | undefined, title = 'Forecast') => (
	<MemoryRouter>
		<NotebookFrame src={src} title={title} />
	</MemoryRouter>
);
const advance = async (milliseconds = 15_000) => {
	await act(() => vi.advanceTimersByTime(milliseconds));
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('NotebookFrame recovery', () => {
	it('offers recovery after a blocked frame fires load, preserving the original token URL', async () => {
		render(frame(SRC));
		const iframe = screen.getByTitle('Forecast');
		fireEvent.load(iframe);
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
		await advance();
		expect(screen.getByRole('status')).toHaveTextContent('Notebook not visible?');
		const link = screen.getByRole('link', { name: 'Open in new window' });
		expect(link).toHaveAttribute('href', SRC);
		expect(link).toHaveAttribute('target', '_blank');
		expect(link).toHaveAttribute('rel', 'noopener noreferrer');
		expect(screen.getByTitle('Forecast')).toBe(iframe);
	});

	it('dismisses help without reloading the running notebook', async () => {
		const { rerender } = render(frame(SRC));
		const iframe = screen.getByTitle('Forecast');
		await advance();
		fireEvent.click(screen.getByRole('button', { name: 'Dismiss notebook help' }));
		rerender(frame(SRC));
		fireEvent.load(iframe);
		await advance();
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
		expect(screen.getByTitle('Forecast')).toBe(iframe);
	});

	it('retries only the iframe and restarts the recovery delay', async () => {
		render(frame(SRC));
		const iframe = screen.getByTitle('Forecast');
		await advance();
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(screen.getByTitle('Forecast')).not.toBe(iframe);
		expect(screen.getByTitle('Forecast')).toHaveAttribute('src', SRC);
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
		await advance();
		expect(screen.getByRole('status')).toBeInTheDocument();
	});

	it('resets dismissed recovery when the session URL changes', async () => {
		const { rerender } = render(frame(SRC));
		await advance();
		fireEvent.click(screen.getByRole('button', { name: 'Dismiss notebook help' }));
		rerender(frame('https://another-kernel.example/'));
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
		await advance();
		expect(screen.getByRole('link', { name: 'Open in new window' })).toHaveAttribute(
			'href',
			'https://another-kernel.example/',
		);
	});

	it('does not show help before the delay, including after metadata rerenders', async () => {
		const { rerender } = render(frame(SRC));
		const iframe = screen.getByTitle('Forecast');
		await advance(10_000);
		rerender(frame(SRC, 'Renamed notebook'));
		expect(screen.getByTitle('Renamed notebook')).toBe(iframe);
		await advance(4999);
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
		await advance(1);
		expect(screen.getByRole('status')).toBeInTheDocument();
	});

	it('cancels the previous URL timeout when switching kernels before it fires', async () => {
		const { rerender } = render(frame(SRC));
		await advance(10_000);
		rerender(frame('https://second-kernel.example/'));
		await advance(5000);
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
		await advance(10_000);
		expect(screen.getByRole('link', { name: 'Open in new window' })).toHaveAttribute(
			'href',
			'https://second-kernel.example/',
		);
	});

	it('cancels recovery when the URL disappears and starts fresh on reattachment', async () => {
		const { rerender } = render(frame(SRC));
		await advance(10_000);
		rerender(frame(undefined));
		await advance();
		expect(screen.queryByTitle('Forecast')).not.toBeInTheDocument();
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
		rerender(frame(SRC));
		await advance(14_999);
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
		await advance(1);
		expect(screen.getByRole('status')).toBeInTheDocument();
	});

	it.each([undefined, ''])(
		'does not create a frame or recovery prompt without a URL (%s)',
		async (src) => {
			render(frame(src));
			await advance();
			expect(screen.queryByTitle('Forecast')).not.toBeInTheDocument();
			expect(screen.queryByRole('status')).not.toBeInTheDocument();
		},
	);

	it.each([
		'/hub/proxy/signed-routing-token/?theme=dark#cell',
		'https://kernel.example/?access_token=a%2Bb&provider=one&provider=two#cell',
	])('preserves the full URL across repeated retries: %s', async (src) => {
		render(frame(src));
		for (let attempt = 0; attempt < 2; attempt++) {
			await advance();
			expect(screen.getByRole('link', { name: 'Open in new window' })).toHaveAttribute('href', src);
			const iframe = screen.getByTitle('Forecast');
			fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
			expect(screen.getByTitle('Forecast')).not.toBe(iframe);
			expect(screen.getByTitle('Forecast')).toHaveAttribute('src', src);
			expect(screen.queryByRole('status')).not.toBeInTheDocument();
		}
	});
});
