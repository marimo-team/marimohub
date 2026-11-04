import { Button as AriaButton } from 'react-aria-components';
import type { ButtonProps as AriaButtonProps } from 'react-aria-components';
import { Link } from 'react-router-dom';
import type { LinkProps } from 'react-router-dom';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
	'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[color,background-color,border-color,box-shadow,transform,opacity] cursor-pointer active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:min-h-11 motion-reduce:transition-none',
	{
		variants: {
			variant: {
				default:
					'border border-input bg-card text-foreground hover:border-primary/50 hover:text-primary',
				primary:
					'border border-primary bg-primary text-primary-foreground hover:bg-primary/90 branded:hover:bg-primary-hover branded:hover:text-primary-hover-foreground',
				ghost:
					'border border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-accent hover:text-primary',
				danger: 'border border-destructive bg-destructive text-white hover:bg-destructive/90',
			},
			size: {
				sm: 'h-7 px-2.5 text-xs',
				md: 'h-8 px-3 text-[13px]',
			},
		},
		defaultVariants: {
			variant: 'default',
			size: 'md',
		},
	},
);

export interface ButtonProps extends AriaButtonProps {
	variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'unstyled';
	size?: 'sm' | 'md';
}

export function Button({
	variant = 'default',
	size = 'md',
	className = '',
	children,
	...props
}: ButtonProps) {
	if (variant === 'unstyled') {
		return (
			<AriaButton className={className} {...props}>
				{children}
			</AriaButton>
		);
	}

	return (
		<AriaButton className={cn(buttonVariants({ variant, size }), className)} {...props}>
			{children}
		</AriaButton>
	);
}

export interface LinkButtonProps extends Omit<LinkProps, 'className'> {
	variant?: 'default' | 'primary' | 'ghost' | 'danger';
	size?: 'sm' | 'md';
	className?: string;
}

/**
 * Like `Button`, but renders a react-router `<Link>` so cmd/ctrl/middle-click
 * open the target in a new tab. Use for labeled navigation styled as a button.
 */
export function LinkButton({
	variant = 'default',
	size = 'md',
	className = '',
	children,
	...props
}: LinkButtonProps) {
	return (
		<Link className={cn(buttonVariants({ variant, size }), className)} {...props}>
			{children}
		</Link>
	);
}
