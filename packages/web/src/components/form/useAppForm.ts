import { createFormHook } from '@tanstack/react-form';
import { fieldContext, formContext } from './form-context';
import { TextField } from './fields/TextField';
import { SwitchField } from './fields/SwitchField';
import { RadioGroupField } from './fields/RadioGroupField';

export const { useAppForm } = createFormHook({
	fieldContext,
	formContext,
	fieldComponents: { TextField, SwitchField, RadioGroupField },
	formComponents: {},
});
