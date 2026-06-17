import { Button as AriaButton } from 'react-aria-components';
import type { ButtonProps as AriaButtonProps } from 'react-aria-components';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
	'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium shadow-xs transition-all cursor-pointer active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:min-h-11',
	{
		variants: {
			variant: {
				default:
					'border border-input bg-card text-foreground hover:border-primary/50 hover:text-primary hover:shadow-sm',
				// The sheen is an inset top highlight (not a bg-image gradient, which
				// tailwind-merge would collapse into the bg-color class).
				primary:
					'border border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/25 inset-shadow-[0_1px_0_rgba(255,255,255,0.2)] hover:bg-primary/90',
				ghost:
					'border border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-accent hover:text-primary',
				danger:
					'border border-destructive bg-destructive text-white inset-shadow-[0_1px_0_rgba(255,255,255,0.15)] hover:bg-destructive/90 hover:shadow-sm',
			},
			size: {
				sm: 'h-7 px-2.5 text-xs',
				md: 'h-9 px-3.5 text-[13px]',
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
