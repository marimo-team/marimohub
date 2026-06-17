import type { AnyFormApi } from '@tanstack/react-form';
import { useSelector } from '@tanstack/react-store';
import { ConfirmDialog as UIConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { ConfirmDialogProps as UIConfirmDialogProps } from '@/components/ui/ConfirmDialog';

export interface ConfirmDialogProps extends Omit<
	UIConfirmDialogProps,
	'onConfirm' | 'confirmDisabled' | 'isPending'
> {
	form: AnyFormApi;
	/** Mutation pending flag; OR'd with the form's own `isSubmitting`. */
	isPending?: boolean;
}

/**
 * The {@link UIConfirmDialog} driven by a `useAppForm` instance — for
 * type-to-confirm destructive actions. `canSubmit` (from the validator) gates
 * the confirm button; the confirm field goes in `children`. Field-less confirms
 * should use the dumb {@link UIConfirmDialog} directly.
 */
export function ConfirmDialog({ form, isPending, ...rest }: ConfirmDialogProps) {
	const canSubmit = useSelector(form.store, (s) => s.canSubmit);
	const isSubmitting = useSelector(form.store, (s) => s.isSubmitting);
	return (
		<UIConfirmDialog
			{...rest}
			isPending={isPending ?? isSubmitting}
			confirmDisabled={!canSubmit}
			onConfirm={() => void form.handleSubmit()}
		/>
	);
}
