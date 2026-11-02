import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { renderWithClient } from '@/test/render';
import { useWorkspaceSearchShortcut } from './useWorkspaceSearchShortcut';

function Harness({ enabled }: { enabled: boolean }) {
	useWorkspaceSearchShortcut(enabled);
	const location = useLocation();
	return (
		<>
			<output aria-label="Location">
				{location.pathname}
				{location.search}
			</output>
			<output aria-label="Focus">{String(location.state?.focusSearch === true)}</output>
			<output aria-label="Key">{location.key}</output>
			<input aria-label="Editor" />
		</>
	);
}
function setup(platform = 'MacIntel', enabled = true, route = '/projects/alpha') {
	vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform);
	return renderWithClient(<Harness enabled={enabled} />, { route, toaster: false });
}
afterEach(() => vi.restoreAllMocks());
describe('Workspace search shortcut', () => {
	it.each(['/search/', '/projects/alpha/search/'])(
		'preserves scope on trailing-slash routes (%s)',
		(route) => {
			setup('MacIntel', true, `${route}?q=revenue`);
			fireEvent.keyDown(document, { key: 'k', metaKey: true });
			expect(screen.getByRole('status', { name: 'Location' }).textContent).toBe(
				`${route}?q=revenue`,
			);
		},
	);
	it('stops intercepting shortcuts after availability changes', () => {
		const { rerender } = setup();
		rerender(<Harness enabled={false} />);
		expect(fireEvent.keyDown(document, { key: 'k', metaKey: true })).toBe(true);
	});
	it('respects an event handled by another control', () => {
		setup();
		const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true });
		event.preventDefault();
		document.dispatchEvent(event);
		expect(screen.getByRole('status', { name: 'Location' }).textContent).toBe('/projects/alpha');
	});
	it.each([
		['MacIntel', { metaKey: true }],
		['Linux', { ctrlKey: true }],
	])('opens global search on %s while typing', (platform, modifiers) => {
		setup(platform);
		screen.getByRole('textbox').focus();
		fireEvent.keyDown(document, { key: 'k', ...modifiers });
		expect(screen.getByRole('status', { name: 'Location' }).textContent).toBe('/search');
		expect(screen.getByRole('status', { name: 'Focus' })).toHaveTextContent('true');
	});
	it('preserves an existing search scope and requests focus again on repeated shortcuts', () => {
		setup('MacIntel', true, '/projects/alpha/search?q=revenue&kind=code');
		fireEvent.keyDown(document, { key: 'k', metaKey: true });
		const key = screen.getByRole('status', { name: 'Key' }).textContent;
		fireEvent.keyDown(document, { key: 'k', metaKey: true });
		expect(screen.getByRole('status', { name: 'Key' }).textContent).not.toBe(key);
		expect(screen.getByRole('status', { name: 'Location' }).textContent).toBe(
			'/projects/alpha/search?q=revenue&kind=code',
		);
	});
	it.each([
		{ key: 'k', ctrlKey: true },
		{ key: 'k', metaKey: true, altKey: true },
		{ key: 'k', metaKey: true, shiftKey: true },
		{ key: 'k', metaKey: true, isComposing: true },
		{ key: 'k', metaKey: true, repeat: true },
	])('ignores unrelated or composing key events (%j)', (event) => {
		setup();
		fireEvent.keyDown(document, event);
		expect(screen.getByRole('status', { name: 'Location' }).textContent).toBe('/projects/alpha');
	});
	it('does not intercept the browser shortcut when disabled', () => {
		setup('MacIntel', false);
		expect(fireEvent.keyDown(document, { key: 'k', metaKey: true })).toBe(true);
		expect(screen.getByRole('status', { name: 'Location' }).textContent).toBe('/projects/alpha');
	});
	it('removes the listener on unmount', () => {
		const { unmount } = setup();
		unmount();
		expect(fireEvent.keyDown(document, { key: 'k', metaKey: true })).toBe(true);
	});
});
