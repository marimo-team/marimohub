import type { ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type { ButtonProps as AriaButtonProps } from 'react-aria-components';
import { Tooltip } from './Tooltip';
import { iconControlClass } from './iconControl';
import type { IconControlSize, IconControlTone, IconControlVariant } from './iconControl';

export interface IconButtonProps extends Omit<AriaButtonProps, 'className' | 'children'> {
	/** Accessible name — required, since the button is icon-only. */
	label: string;
	children: ReactNode;
	size?: IconControlSize;
	tone?: IconControlTone;
	variant?: IconControlVariant;
	/** Optional hover/focus tooltip; defaults to nothing (the `label` is the a11y name). */
	tooltip?: ReactNode;
	className?: string;
}

/**
 * An icon-only button with a required accessible name and a focus-visible ring.
 * Built on react-aria `Button` (use `onPress`). Pass `tooltip` for a hover hint.
 */
export function IconButton({
	label,
	children,
	size,
	tone,
	variant,
	tooltip,
	className,
	...props
}: IconButtonProps) {
	const button = (
		<AriaButton
			aria-label={label}
			className={iconControlClass({ size, tone, variant, className })}
			{...props}
		>
			{children}
		</AriaButton>
	);
	return tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button;
}
