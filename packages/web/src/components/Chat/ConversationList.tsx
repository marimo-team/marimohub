import { MessageSquare, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui';
import type { ConversationSummary } from '@/api/conversations';
import { cn } from '@/lib/utils';
import { formatRelative } from '@/lib/time';

export function ConversationList({
	items,
	selected,
	busy,
	onSelect,
	onDelete,
}: {
	items: ConversationSummary[];
	selected: string | null;
	busy: boolean;
	onSelect: (id: string) => void;
	onDelete: (item: ConversationSummary) => void;
}) {
	return (
		<ul className="divide-y divide-border/60">
			{items.map((item) => (
				<li key={item.id} className="flex items-center gap-2 py-1">
					<Button
						variant="unstyled"
						isDisabled={busy}
						onPress={() => onSelect(item.id)}
						className={cn(
							'flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-3 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring',
							selected === item.id && 'bg-muted',
						)}
					>
						<MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
						<span className="min-w-0">
							<span className="block truncate text-sm font-medium">{item.title}</span>
							<span className="mt-1 block text-xs text-muted-foreground">
								{formatRelative(item.updated_at)}
							</span>
						</span>
					</Button>
					<Button
						variant="ghost"
						size="sm"
						isDisabled={busy}
						aria-label={`Delete conversation ${item.title}`}
						onPress={() => onDelete(item)}
					>
						<Trash2 className="size-3.5" aria-hidden />
					</Button>
				</li>
			))}
		</ul>
	);
}
