import type { ReactNode } from 'react';
import { SearchX } from 'lucide-react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { ListContainer } from './PageLayout';
import { Skeleton } from './Skeleton';

interface ListResultsProps {
	gallery?: boolean;
	children: ReactNode;
	count: number;
	emptyState: ReactNode;
	isFetching: boolean;
	isFiltered: boolean;
	isLoading: boolean;
	itemName: string;
	onReset: () => void;
	resultsId: string;
}

const SKELETON_ROWS = [0, 1, 2];
const GALLERY_CLASSES = 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3';

export function ListResults({
	children,
	gallery = false,
	count,
	emptyState,
	isFetching,
	isFiltered,
	isLoading,
	itemName,
	onReset,
	resultsId,
}: ListResultsProps) {
	let content: ReactNode = gallery ? (
		<div className={GALLERY_CLASSES}>{children}</div>
	) : (
		<ListContainer>{children}</ListContainer>
	);
	if (isLoading) {
		content = <ListSkeleton gallery={gallery} />;
	} else if (count === 0) {
		content = isFiltered ? (
			<EmptyState
				icon={<SearchX />}
				message={`No ${itemName}s match these filters`}
				description={`Adjust the filters or reset them to see all current ${itemName}s.`}
				action={
					<Button variant="default" onPress={onReset}>
						Reset filters
					</Button>
				}
			/>
		) : (
			emptyState
		);
	}

	return (
		<div id={resultsId} aria-busy={isFetching}>
			{content}
		</div>
	);
}

function ListSkeleton({ gallery }: { gallery: boolean }) {
	if (gallery) {
		return (
			<div className={GALLERY_CLASSES}>
				{SKELETON_ROWS.map((row) => (
					<div
						key={row}
						data-testid="gallery-skeleton-card"
						aria-hidden="true"
						className="overflow-hidden rounded-lg border"
					>
						<Skeleton className="aspect-video w-full rounded-none" />
						<div className="flex flex-col gap-2 p-4">
							<Skeleton className="h-4 w-36" />
							<Skeleton className="h-3 w-52 max-w-full" />
						</div>
					</div>
				))}
			</div>
		);
	}
	return (
		<ListContainer>
			{SKELETON_ROWS.map((row) => (
				<div
					key={row}
					data-testid="list-skeleton-row"
					aria-hidden="true"
					className="flex items-center gap-3 border-b p-4 last:border-b-0"
				>
					<Skeleton className="size-9 rounded-lg" />
					<div className="flex flex-1 flex-col gap-2">
						<Skeleton className="h-4 w-36" />
						<Skeleton className="h-3 w-52 max-w-full" />
					</div>
				</div>
			))}
		</ListContainer>
	);
}
