import { Trash2 } from 'lucide-react';
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
		<ul className="space-y-1">
			{items.map((item) => (
				<li
					key={item.id}
					className={cn(
						'group/conversation flex items-center rounded-lg hover:bg-accent/60',
						selected === item.id && 'bg-accent',
					)}
				>
					<Button
						variant="unstyled"
						isDisabled={busy}
						onPress={() => onSelect(item.id)}
						aria-current={selected === item.id ? 'page' : undefined}
						className="flex min-w-0 flex-1 items-center rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span className="min-w-0">
							<span className="block truncate text-sm" title={item.title}>
								{item.title}
							</span>
							<span className="mt-0.5 block text-[11px] text-muted-foreground">
								{formatRelative(item.updated_at)}
							</span>
						</span>
					</Button>
					<Button
						variant="ghost"
						size="sm"
						isDisabled={busy}
						aria-label={`Delete conversation ${item.title}`}
						className="mr-1 shrink-0 group-focus-within/conversation:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/conversation:opacity-100"
						onPress={() => onDelete(item)}
					>
						<Trash2 className="size-3.5" aria-hidden />
					</Button>
				</li>
			))}
		</ul>
	);
}
