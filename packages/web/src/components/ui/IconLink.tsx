import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LinkProps } from 'react-router-dom';
import { Tooltip } from './Tooltip';
import { iconControlClass } from './iconControl';
import type { IconControlSize, IconControlTone, IconControlVariant } from './iconControl';

export interface IconLinkProps extends Omit<LinkProps, 'className' | 'children'> {
	/** Accessible name — required, since the link is icon-only. */
	label: string;
	children: ReactNode;
	size?: IconControlSize;
	tone?: IconControlTone;
	variant?: IconControlVariant;
	tooltip?: ReactNode;
	className?: string;
}

/**
 * Like `IconButton`, but renders a react-router `<Link>` so cmd/ctrl/middle-click
 * open the target in a new tab. Use for icon-only navigation (e.g. back arrows).
 */
export function IconLink({
	label,
	children,
	size,
	tone,
	variant,
	tooltip,
	className,
	...props
}: IconLinkProps) {
	const link = (
		<Link
			aria-label={label}
			className={iconControlClass({ size, tone, variant, className })}
			{...props}
		>
			{children}
		</Link>
	);
	return tooltip ? <Tooltip content={tooltip}>{link}</Tooltip> : link;
}
