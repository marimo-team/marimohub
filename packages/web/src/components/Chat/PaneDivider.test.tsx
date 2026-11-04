import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PaneDivider } from './PaneDivider';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
it('keeps the pane stationary during drag and commits the ghost position on release', () => {
	vi.stubGlobal(
		'PointerEvent',
		class extends MouseEvent {
			readonly pointerId: number;
			constructor(type: string, options: PointerEventInit) {
				super(type, options);
				this.pointerId = options.pointerId ?? 0;
			}
		},
	);
	const changed = vi.fn();
	const { container } = render(
		<div>
			<PaneDivider width={50} onWidth={changed} />
		</div>,
	);
	const parent = container.firstElementChild!;
	vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 10, 1000, 500));
	const divider = screen.getByRole('separator', { name: 'Notebook pane width' });
	Object.defineProperty(divider, 'setPointerCapture', { value: vi.fn() });
	Object.defineProperty(divider, 'releasePointerCapture', { value: vi.fn() });
	fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientX: 500 });
	fireEvent.pointerMove(divider, { pointerId: 1, clientX: 350 });
	expect(changed).not.toHaveBeenCalled();
	expect(divider).toHaveAttribute('aria-valuenow', '50');
	expect(screen.getByTestId('pane-resize-guide')).toHaveStyle({
		left: '350px',
		top: '10px',
		height: '500px',
	});
	expect(screen.getByTestId('pane-resize-shield').parentElement).toBe(document.body);
	fireEvent.pointerUp(divider, { pointerId: 1, clientX: 350 });
	expect(changed).toHaveBeenCalledExactlyOnceWith(65);
	expect(parent.lastElementChild).toBe(divider);
	expect(screen.queryByTestId('pane-resize-shield')).not.toBeInTheDocument();
});
it('supports bounded arrow-key resizing and cancels a pointer drag without a width change', () => {
	vi.stubGlobal(
		'PointerEvent',
		class extends MouseEvent {
			readonly pointerId: number;
			constructor(type: string, options: PointerEventInit) {
				super(type, options);
				this.pointerId = options.pointerId ?? 0;
			}
		},
	);
	const changed = vi.fn();
	const { container } = render(
		<div>
			<PaneDivider width={70} onWidth={changed} />
		</div>,
	);
	const parent = container.firstElementChild!;
	vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 10, 1000, 500));
	const divider = screen.getByRole('separator', { name: 'Notebook pane width' });
	Object.defineProperty(divider, 'setPointerCapture', { value: vi.fn() });
	Object.defineProperty(divider, 'releasePointerCapture', { value: vi.fn() });
	fireEvent.keyDown(divider, { key: 'ArrowLeft' });
	expect(changed).toHaveBeenLastCalledWith(70);
	fireEvent.keyDown(divider, { key: 'ArrowRight' });
	expect(changed).toHaveBeenLastCalledWith(65);
	fireEvent.keyDown(divider, { key: 'Home' });
	expect(changed).toHaveBeenLastCalledWith(30);
	changed.mockClear();
	fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientX: 300 });
	fireEvent.pointerMove(divider, { pointerId: 1, clientX: 450 });
	expect(screen.getByTestId('pane-resize-guide')).toBeInTheDocument();
	fireEvent.pointerCancel(divider, { pointerId: 1 });
	expect(screen.queryByTestId('pane-resize-guide')).not.toBeInTheDocument();
	expect(changed).not.toHaveBeenCalled();
	fireEvent.pointerDown(divider, { pointerId: 2, button: 0, clientX: 300 });
	fireEvent.pointerMove(divider, { pointerId: 2, clientX: 450 });
	expect(screen.getByTestId('pane-resize-guide')).toBeInTheDocument();
	fireEvent.keyDown(divider, { key: 'Escape' });
	expect(screen.queryByTestId('pane-resize-guide')).not.toBeInTheDocument();
	expect(changed).not.toHaveBeenCalled();
	fireEvent.pointerUp(divider, { pointerId: 2, clientX: 450 });
	expect(changed).not.toHaveBeenCalled();
	fireEvent.keyDown(divider, { key: 'End' });
	expect(changed).toHaveBeenCalledExactlyOnceWith(70);
});
