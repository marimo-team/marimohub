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
	width?: 'sm' | 'md' | 'lg' | 'form' | 'xl' | 'screen';
	contentClassName?: string;
}

const widthClasses: Record<NonNullable<DialogModalProps['width']>, string> = {
	sm: 'max-w-sm',
	md: 'max-w-md',
	lg: 'max-w-lg',
	form: 'max-w-2xl',
	xl: 'max-w-6xl',
	screen: 'h-[92dvh] max-w-[95vw]',
};

export function DialogModal({
	isOpen,
	onClose,
	title,
	children,
	width = 'md',
	contentClassName,
}: DialogModalProps) {
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
				<Dialog
					className={cn(
						'flex max-h-[calc(100dvh-2rem)] flex-col outline-none',
						width === 'screen' && 'h-full',
					)}
				>
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
					<div className={cn('min-h-0 overflow-y-auto overscroll-contain p-5', contentClassName)}>
						{children}
					</div>
				</Dialog>
			</Modal>
		</ModalOverlay>
	);
}
