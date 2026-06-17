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
					'border border-input bg-background text-muted-foreground hover:border-primary hover:text-primary hover:shadow-sm',
				primary:
					'border border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-sm',
				ghost:
					'border border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-accent hover:text-primary',
				danger:
					'border border-destructive bg-destructive text-white hover:bg-destructive/90 hover:shadow-sm',
			},
			size: {
				sm: 'px-2 py-1 text-xs',
				md: 'px-3 py-2 text-[13px]',
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
