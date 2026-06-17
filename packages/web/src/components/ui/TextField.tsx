import { TextField as AriaTextField, Label, Input, FieldError } from 'react-aria-components';
import type { TextFieldProps as AriaTextFieldProps } from 'react-aria-components';
import { cn } from '@/lib/utils';

export interface TextFieldProps extends Omit<AriaTextFieldProps, 'children'> {
	label?: string;
	placeholder?: string;
	error?: string;
}

export function TextField({ label, placeholder, error, className = '', ...props }: TextFieldProps) {
	return (
		<AriaTextField
			className={cn('flex flex-col gap-1.5', className)}
			isInvalid={!!error}
			{...props}
		>
			{label && <Label className="text-xs font-medium text-muted-foreground">{label}</Label>}
			<Input
				placeholder={placeholder}
				className={cn(
					'h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors',
					'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
					'data-[invalid]:border-destructive data-[invalid]:focus-visible:ring-destructive',
				)}
			/>
			{error && <FieldError className="text-xs text-destructive">{error}</FieldError>}
		</AriaTextField>
	);
}
