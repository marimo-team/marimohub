import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { PanelLeftClose, Plus } from 'lucide-react';
import type { ConversationSummary } from '@/api/conversations';
import { Button } from '@/components/ui';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { ConversationList } from './ConversationList';

export function ConversationSidebar({
	open,
	onClose,
	items,
	selected,
	busy,
	loading,
	error,
	onRetry,
	onSelect,
	onDelete,
}: {
	open: boolean;
	onClose: () => void;
	items: ConversationSummary[];
	selected: string | null;
	busy: boolean;
	loading: boolean;
	error?: string;
	onRetry: () => void;
	onSelect: (id: string | null) => void;
	onDelete: (item: ConversationSummary) => void;
}) {
	const mobile = useIsMobile();
	const select = (id: string | null) => {
		onSelect(id);
		if (mobile) onClose();
	};
	const content = (
		<>
			<div className="flex h-16 shrink-0 items-center justify-between px-4">
				<h2 className="text-sm font-medium">Chats</h2>
				<Button variant="ghost" size="sm" aria-label="Collapse history" onPress={onClose}>
					<PanelLeftClose className="size-4" aria-hidden />
				</Button>
			</div>
			<div className="px-3 pb-3">
				<Button
					variant="ghost"
					onPress={() => select(null)}
					isDisabled={busy}
					className="w-full justify-start"
					aria-label="Start a new chat"
				>
					<Plus className="size-4" aria-hidden />
					New chat
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
				{loading ? (
					<output className="block px-3 py-4 text-xs text-muted-foreground">
						Loading conversations…
					</output>
				) : error ? (
					<div role="alert" className="space-y-2 px-3 py-4 text-xs text-destructive">
						<p>{error}</p>
						<Button size="sm" onPress={onRetry}>
							Retry history
						</Button>
					</div>
				) : items.length === 0 ? (
					<p className="px-3 py-4 text-xs text-muted-foreground">No conversations yet.</p>
				) : (
					<ConversationList
						items={items}
						selected={selected}
						busy={busy}
						onSelect={select}
						onDelete={onDelete}
					/>
				)}
			</div>
		</>
	);
	if (mobile)
		return (
			<ModalOverlay
				isOpen={open}
				onOpenChange={(value) => {
					if (!value) onClose();
				}}
				isDismissable
				className="fixed inset-0 z-50 bg-black/30"
			>
				<Modal className="h-dvh w-72 max-w-[85vw] bg-card text-card-foreground shadow-xl">
					<Dialog
						id="chat-conversations"
						aria-label="Your conversations"
						className="flex h-full flex-col outline-none"
					>
						{content}
					</Dialog>
				</Modal>
			</ModalOverlay>
		);
	return open ? (
		<aside
			id="chat-conversations"
			aria-label="Your conversations"
			className="flex w-60 shrink-0 flex-col border-r bg-muted/20"
		>
			{content}
		</aside>
	) : null;
}
