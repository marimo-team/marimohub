import type { ReactNode, KeyboardEventHandler } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import type { SearchHit } from '@/api/search';
import { cn } from '@/lib/utils';
import { searchKinds } from './presentation';

export function SearchSnippet({ snippet }: { snippet: SearchHit['snippet'] }) {
	const parts: ReactNode[] = [];
	let offset = 0;
	for (const { start, end } of snippet.highlights) {
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < offset ||
			end <= start ||
			end > snippet.text.length
		)
			continue;
		parts.push(snippet.text.slice(offset, start));
		parts.push(
			<mark key={start} className="rounded-sm bg-primary/15 text-inherit">
				{snippet.text.slice(start, end)}
			</mark>,
		);
		offset = end;
	}
	parts.push(snippet.text.slice(offset));
	return parts;
}

export function SearchResult({
	item,
	onKeyDown,
}: {
	item: SearchHit;
	onKeyDown?: KeyboardEventHandler<HTMLAnchorElement>;
}) {
	const { icon: Icon, singular } = searchKinds[item.kind];
	return (
		<li>
			<Link
				to={item.href}
				onKeyDown={onKeyDown}
				data-search-hit
				className="group flex gap-4 rounded-lg px-3 py-4 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring max-sm:gap-3 max-sm:px-2"
			>
				<span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
					<Icon className="size-5" aria-hidden />
				</span>
				<div className="min-w-0 flex-1">
					<h2 className="min-w-0 break-words text-base font-semibold text-foreground group-hover:text-primary">
						{item.title}
					</h2>
					<p className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
						<span className="truncate">{item.project_name}</span>
						<span aria-hidden>·</span>
						<span className="shrink-0">{singular}</span>
					</p>
					<div className={cn('mt-2', item.kind === 'code' && 'rounded-md bg-muted/60 px-3 py-2')}>
						<p
							className={cn(
								'line-clamp-3 whitespace-normal break-words text-sm leading-6 text-foreground/80',
								item.kind === 'code' && 'font-mono text-xs whitespace-pre-wrap',
							)}
						>
							<SearchSnippet snippet={item.snippet} />
						</p>
					</div>
				</div>
				<ArrowUpRight
					className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 max-sm:hidden"
					aria-hidden
				/>
			</Link>
		</li>
	);
}
