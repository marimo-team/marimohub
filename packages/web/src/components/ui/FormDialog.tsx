import type { ReactNode } from 'react';
import { Button } from './Button';
import type { ButtonProps } from './Button';
import { DialogModal } from './Dialog';
import type { DialogModalProps } from './Dialog';

export interface FormDialogProps {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	/** The form fields. */
	children: ReactNode;
	submitLabel: string;
	/** Label shown on the submit button while the request is in flight. */
	pendingLabel?: string;
	isPending?: boolean;
	/** Disable submit independent of pending (e.g. a required field is empty). */
	submitDisabled?: boolean;
	/** Submit-button emphasis. Defaults to `primary`. */
	submitVariant?: ButtonProps['variant'];
	onSubmit: () => void;
	cancelLabel?: string;
	width?: DialogModalProps['width'];
}

/**
 * A dumb form dialog: a titled modal wrapping a `<form>` with the standard
 * vertical field stack and a Cancel / Submit button pair. `onSubmit` fires on
 * submit (Enter or the button) with `preventDefault` handled. The caller owns the
 * fields (`children`), the pending flag, and the submit handler — this only lays
 * them out. Pairs with {@link ConfirmDialog} for the destructive case.
 */
export function FormDialog({
	isOpen,
	onClose,
	title,
	children,
	submitLabel,
	pendingLabel,
	isPending = false,
	submitDisabled = false,
	submitVariant = 'primary',
	onSubmit,
	cancelLabel = 'Cancel',
	width = 'sm',
}: FormDialogProps) {
	return (
		<DialogModal isOpen={isOpen} onClose={onClose} title={title} width={width}>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					onSubmit();
				}}
			>
				<div className="flex flex-col gap-4">
					{children}
					<div className="flex justify-end gap-2 pt-2 max-md:flex-col">
						<Button variant="ghost" onPress={onClose}>
							{cancelLabel}
						</Button>
						<Button type="submit" variant={submitVariant} isDisabled={isPending || submitDisabled}>
							{isPending ? (pendingLabel ?? submitLabel) : submitLabel}
						</Button>
					</div>
				</div>
			</form>
		</DialogModal>
	);
}
