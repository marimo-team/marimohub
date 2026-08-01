import type { ReactNode } from 'react';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconButton } from './IconButton';

export interface DialogModalProps {
	isOpen: boolean;
	onClose: () => void;
	title?: string;
	children: ReactNode;
	width?: 'sm' | 'md' | 'lg' | 'xl';
}

const widthClasses: Record<NonNullable<DialogModalProps['width']>, string> = {
	sm: 'max-w-sm',
	md: 'max-w-md',
	lg: 'max-w-lg',
	xl: 'max-w-6xl',
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
				'fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-[2px]',
				'entering:animate-in entering:fade-in-0 exiting:animate-out exiting:fade-out-0',
			)}
		>
			<Modal
				className={cn(
					'max-h-[calc(100dvh-2rem)] w-full overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xl',
					'entering:animate-in entering:zoom-in-95 exiting:animate-out exiting:zoom-out-95',
					widthClasses[width],
				)}
			>
				<Dialog className="flex max-h-[calc(100dvh-2rem)] flex-col outline-none">
					{title && (
						<div className="flex shrink-0 items-center justify-between border-b px-5 py-3.5">
							<Heading slot="title" className="text-sm font-semibold">
								{title}
							</Heading>
							<IconButton label="Close" onPress={onClose}>
								<X className="size-4" />
							</IconButton>
						</div>
					)}
					<div className="min-h-0 overflow-y-auto overscroll-contain p-5">{children}</div>
				</Dialog>
			</Modal>
		</ModalOverlay>
	);
}
