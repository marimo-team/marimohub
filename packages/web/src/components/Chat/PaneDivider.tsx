import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- This focusable window splitter needs pointer and keyboard handlers. */

const clamp = (value: number) => Math.min(70, Math.max(30, value));

export function PaneDivider({
	width,
	onWidth,
}: {
	width: number;
	onWidth: (width: number) => void;
}) {
	const drag = useRef<{ pointer: number; bounds: DOMRect; width: number } | null>(null);
	const [guide, setGuide] = useState<{ left: number; top: number; height: number } | null>(null);
	return (
		<>
			<div
				role="separator"
				aria-label="Notebook pane width"
				aria-orientation="vertical"
				aria-valuemin={30}
				aria-valuemax={70}
				aria-valuenow={width}
				tabIndex={0}
				className="relative m-0 hidden h-auto w-1.5 shrink-0 cursor-col-resize touch-none self-stretch border-0 bg-border/60 outline-none hover:bg-primary/25 focus-visible:bg-primary/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring lg:block"
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
					if (!bounds?.width) return;
					event.preventDefault();
					event.currentTarget.focus();
					event.currentTarget.setPointerCapture(event.pointerId);
					drag.current = { pointer: event.pointerId, bounds, width };
					setGuide({
						left: bounds.right - (bounds.width * width) / 100,
						top: bounds.top,
						height: bounds.height,
					});
				}}
				onPointerMove={(event) => {
					const current = drag.current;
					if (!current || current.pointer !== event.pointerId) return;
					current.width = clamp(
						((current.bounds.right - event.clientX) / current.bounds.width) * 100,
					);
					setGuide({
						left: current.bounds.right - (current.bounds.width * current.width) / 100,
						top: current.bounds.top,
						height: current.bounds.height,
					});
				}}
				onPointerUp={(event) => {
					const current = drag.current;
					if (!current || current.pointer !== event.pointerId) return;
					drag.current = null;
					setGuide(null);
					event.currentTarget.releasePointerCapture(event.pointerId);
					onWidth(Math.round(current.width));
				}}
				onPointerCancel={() => {
					drag.current = null;
					setGuide(null);
				}}
				onLostPointerCapture={() => {
					drag.current = null;
					setGuide(null);
				}}
				onKeyDown={(event) => {
					if (event.key === 'Escape') {
						drag.current = null;
						setGuide(null);
						return;
					}
					const next =
						event.key === 'ArrowLeft'
							? width + 5
							: event.key === 'ArrowRight'
								? width - 5
								: event.key === 'Home'
									? 30
									: event.key === 'End'
										? 70
										: undefined;
					if (next !== undefined) {
						event.preventDefault();
						onWidth(clamp(next));
					}
				}}
			/>
			{guide
				? createPortal(
						// Keep the drag in this document across the notebook iframe.
						<div
							aria-hidden
							data-testid="pane-resize-shield"
							className="fixed inset-0 z-50 cursor-col-resize touch-none"
						>
							<div
								data-testid="pane-resize-guide"
								className="pointer-events-none fixed w-0.5 bg-primary shadow-sm"
								style={guide}
							/>
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
