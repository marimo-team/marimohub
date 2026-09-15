import { MoreHorizontal } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils';

const tagClassName = 'rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground';

export function NotebookTags({ tags, title }: { tags: string[]; title: string }) {
	return (
		<div className="flex shrink-0 items-center gap-1 md:w-44">
			{tags.slice(0, 2).map((tag) => (
				<span
					key={tag}
					title={tag}
					className={cn(tagClassName, 'hidden min-w-0 max-w-32 truncate md:block')}
				>
					{tag}
				</span>
			))}
			{tags.length > 0 && (
				<Popover
					label={`Show ${tags.length === 1 ? 'tag' : `all ${tags.length} tags`} for ${title}`}
					placement="bottom start"
					trigger={<MoreHorizontal className="size-3.5" aria-hidden="true" />}
					triggerClassName={cn(
						'size-6 shrink-0 cursor-pointer justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground',
						tags.length <= 2 && 'md:hidden',
					)}
				>
					<p className="mb-2 text-xs font-medium">Tags</p>
					<div className="flex max-h-60 flex-wrap gap-1.5 overflow-y-auto">
						{tags.map((tag) => (
							<span key={tag} className={cn(tagClassName, 'min-w-0 wrap-anywhere')}>
								{tag}
							</span>
						))}
					</div>
				</Popover>
			)}
		</div>
	);
}
