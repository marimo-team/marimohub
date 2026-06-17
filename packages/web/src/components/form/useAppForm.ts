import { createFormHook } from '@tanstack/react-form';
import { fieldContext, formContext } from './form-context';
import { TextField } from './fields/TextField';
import { SwitchField } from './fields/SwitchField';

export const { useAppForm, withForm } = createFormHook({
	fieldContext,
	formContext,
	fieldComponents: { TextField, SwitchField },
	formComponents: {},
});
