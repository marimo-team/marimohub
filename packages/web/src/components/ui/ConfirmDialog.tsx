import type { ReactNode } from 'react';
import { Button } from './Button';
import type { ButtonProps } from './Button';
import { DialogModal } from './Dialog';

export interface ConfirmDialogProps {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	/** Body copy explaining the consequence of confirming. */
	description: ReactNode;
	confirmLabel: string;
	/** Label shown on the confirm button while the action is in flight. */
	pendingLabel?: string;
	isPending?: boolean;
	/** Disable confirm independent of pending (e.g. a type-to-confirm guard). */
	confirmDisabled?: boolean;
	/** Confirm-button emphasis. Defaults to `danger`. */
	variant?: ButtonProps['variant'];
	onConfirm: () => void;
	/** Extra content between the description and the buttons, e.g. a confirm field. */
	children?: ReactNode;
}

/**
 * A dumb confirm/destroy dialog: description, optional extra content, and a
 * Cancel / Confirm button pair. The caller owns the wording, the pending flag,
 * and the confirm handler — this only lays them out. Replaces the per-action
 * hand-rolled dialogs (delete notebook, stop kernel, delete project).
 */
export function ConfirmDialog({
	isOpen,
	onClose,
	title,
	description,
	confirmLabel,
	pendingLabel,
	isPending = false,
	confirmDisabled = false,
	variant = 'danger',
	onConfirm,
	children,
}: ConfirmDialogProps) {
	const handleClose = () => {
		if (!isPending) onClose();
	};

	return (
		<DialogModal isOpen={isOpen} onClose={handleClose} title={title} width="sm">
			<form
				aria-busy={isPending}
				onSubmit={(e) => {
					e.preventDefault();
					// Guard so Enter can't bypass a type-to-confirm guard or double-fire
					// while the action is in flight.
					if (isPending || confirmDisabled) return;
					onConfirm();
				}}
			>
				<div className="flex flex-col gap-4">
					<p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
					{children}
					<div className="flex justify-end gap-2 pt-2 max-md:flex-col">
						<Button type="button" variant="ghost" onPress={handleClose} isDisabled={isPending}>
							Cancel
						</Button>
						<Button
							type="submit"
							variant={variant}
							isDisabled={isPending || confirmDisabled}
							// With no extra field, focus the confirm button so Enter confirms.
							// When `children` is a field (type-to-confirm), the caller focuses
							// it instead and the form's implicit submit handles Enter.
							autoFocus={!children}
						>
							<span aria-live="polite">
								{isPending ? (pendingLabel ?? confirmLabel) : confirmLabel}
							</span>
						</Button>
					</div>
				</div>
			</form>
		</DialogModal>
	);
}
