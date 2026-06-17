import type { AnyFormApi } from '@tanstack/react-form';
import { useSelector } from '@tanstack/react-store';
import { FormDialog as UIFormDialog } from '@/components/ui/FormDialog';
import type { FormDialogProps as UIFormDialogProps } from '@/components/ui/FormDialog';

export interface FormDialogProps extends Omit<
	UIFormDialogProps,
	'onSubmit' | 'submitDisabled' | 'isPending'
> {
	form: AnyFormApi;
	/** Mutation pending flag; OR'd with the form's own `isSubmitting`. */
	isPending?: boolean;
	/** Also disable submit until the form is dirty (e.g. an "unchanged toggle"). */
	requireDirty?: boolean;
}

/**
 * Drives the dumb {@link UIFormDialog} from a `useAppForm` instance: forwards
 * `canSubmit`/`isSubmitting`/`isDirty` and runs the form's submit. The fields go
 * in `children` as bound `form.AppField`s.
 */
export function FormDialog({ form, isPending, requireDirty = false, ...rest }: FormDialogProps) {
	// Separate primitive selectors so the footer re-renders only when one of these
	// booleans flips — not on every keystroke (useSelector compares with ===).
	const canSubmit = useSelector(form.store, (s) => s.canSubmit);
	const isSubmitting = useSelector(form.store, (s) => s.isSubmitting);
	const isDirty = useSelector(form.store, (s) => s.isDirty);
	return (
		<UIFormDialog
			{...rest}
			isPending={isPending ?? isSubmitting}
			submitDisabled={!canSubmit || (requireDirty && !isDirty)}
			onSubmit={() => void form.handleSubmit()}
		/>
	);
}
