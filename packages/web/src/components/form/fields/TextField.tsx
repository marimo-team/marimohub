import { TextField as UITextField } from '@/components/ui/TextField';
import type { TextFieldProps as UITextFieldProps } from '@/components/ui/TextField';
import { useFieldContext } from '../form-context';
import { firstError } from '../errors';

export type TextFieldProps = Omit<UITextFieldProps, 'value' | 'onChange' | 'error' | 'onBlur'>;

/** A {@link UITextField} bound to its enclosing `form.AppField`. */
export function TextField(props: TextFieldProps) {
	const field = useFieldContext<string>();
	return (
		<UITextField
			{...props}
			value={field.state.value}
			onChange={field.handleChange}
			onBlur={field.handleBlur}
			error={firstError(field.state.meta)}
		/>
	);
}
