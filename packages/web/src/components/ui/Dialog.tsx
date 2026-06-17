import type { ReactNode } from 'react';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DialogModalProps {
	isOpen: boolean;
	onClose: () => void;
	title?: string;
	children: ReactNode;
	width?: 'sm' | 'md' | 'lg';
}

const widthClasses: Record<NonNullable<DialogModalProps['width']>, string> = {
	sm: 'max-w-sm',
	md: 'max-w-md',
	lg: 'max-w-lg',
};

export function DialogModal({ isOpen, onClose, title, children, width = 'md' }: DialogModalProps) {
	return (
		<ModalOverlay
			isOpen={isOpen}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			isDismissable
			className={cn(
				'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4',
				'entering:animate-in entering:fade-in-0 exiting:animate-out exiting:fade-out-0',
			)}
		>
			<Modal
				className={cn(
					'w-full rounded-lg border bg-card text-card-foreground shadow-lg',
					'entering:animate-in entering:zoom-in-95 exiting:animate-out exiting:zoom-out-95',
					widthClasses[width],
				)}
			>
				<Dialog className="outline-none">
					{title && (
						<div className="flex items-center justify-between border-b px-4 py-3">
							<Heading slot="title" className="text-sm font-semibold">
								{title}
							</Heading>
							<button
								onClick={onClose}
								aria-label="Close"
								className="text-muted-foreground transition-colors hover:text-foreground"
							>
								<X className="size-4" />
							</button>
						</div>
					)}
					<div className="p-4">{children}</div>
				</Dialog>
			</Modal>
		</ModalOverlay>
	);
}
