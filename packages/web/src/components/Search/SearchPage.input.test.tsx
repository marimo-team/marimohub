import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { setup } from '@/test/search';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function ready() {
	const page = setup();
	await screen.findByRole('link', { name: /Revenue model/ });
	vi.useFakeTimers();
	return { ...page, input: screen.getByRole('searchbox') };
}
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('search submission', () => {
	it('waits for 500 ms of inactivity and resets the delay on every edit', async () => {
		const { input, searches } = await ready();
		fireEvent.change(input, { target: { value: 'r' } });
		await advance(400);
		fireEvent.change(input, { target: { value: 'report' } });
		await advance(499);
		expect(searches).toHaveLength(1);
		expect(screen.queryByRole('link')).not.toBeInTheDocument();
		expect(screen.getByText('Press Enter to search now')).toBeVisible();
		await advance(1);
		expect(searches).toHaveLength(2);
		expect(searches[1].searchParams.get('q')).toBe('report');
	});
	it('still debounces when typing returns to the previously searched value', async () => {
		const { input, searches } = await ready();
		fireEvent.change(input, { target: { value: 'revenues' } });
		await advance(200);
		fireEvent.change(input, { target: { value: 'revenue' } });
		await advance(499);
		expect(searches).toHaveLength(1);
		await advance(1);
		expect(searches).toHaveLength(2);
	});
	it.each(['Enter', 'button'])(
		'submits immediately with %s without a duplicate after the delay',
		async (trigger) => {
			const { input, searches } = await ready();
			fireEvent.change(input, { target: { value: 'profit' } });
			if (trigger === 'Enter') fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
			else fireEvent.click(screen.getByRole('button', { name: 'Search' }));
			await advance(0);
			expect(searches).toHaveLength(2);
			expect(searches[1].searchParams.get('q')).toBe('profit');
			await advance(600);
			expect(searches).toHaveLength(2);
			fireEvent.change(input, { target: { value: 'profit margin' } });
			await advance(499);
			expect(searches).toHaveLength(2);
			await advance(1);
			expect(searches).toHaveLength(3);
		},
	);
	it('does not submit Enter during composition and starts the delay after composition ends', async () => {
		const { input, searches } = await ready();
		fireEvent.compositionStart(input);
		fireEvent.change(input, { target: { value: '売上' } });
		fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
		await advance(600);
		expect(searches).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
		fireEvent.compositionEnd(input);
		await advance(499);
		expect(searches).toHaveLength(1);
		await advance(1);
		expect(searches).toHaveLength(2);
	});
	it.each(['clear', 'unmount'])('cancels the scheduled search on %s', async (action) => {
		const { input, searches, unmount } = await ready();
		fireEvent.change(input, { target: { value: 'profit' } });
		await advance(300);
		if (action === 'clear') fireEvent.keyDown(input, { key: 'Escape' });
		else unmount();
		await advance(600);
		expect(searches).toHaveLength(1);
	});
	it.each(['   ', 'x'.repeat(257)])('does not submit empty or invalid input', async (value) => {
		const { input, searches } = await ready();
		fireEvent.change(input, { target: { value } });
		fireEvent.keyDown(input, { key: 'Enter' });
		await advance(600);
		expect(searches).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
	});
	it('allows Enter to refresh an unchanged query', async () => {
		const { user, searches } = setup();
		await screen.findByRole('link', { name: /Revenue model/ });
		await user.click(screen.getByRole('searchbox'));
		await user.keyboard('{Enter}');
		await waitFor(() => expect(searches).toHaveLength(2));
		expect(searches[1].searchParams.get('q')).toBe('revenue');
	});
	it('searches a bookmarked URL immediately', async () => {
		const { searches } = setup({ route: '/search?q=bookmarked' });
		await waitFor(() => expect(searches).toHaveLength(1));
		expect(searches[0].searchParams.get('q')).toBe('bookmarked');
	});
});
