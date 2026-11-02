import type { Key, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface DataTableColumn<T> {
	id: string;
	header: ReactNode;
	cell: (item: T) => ReactNode;
	/** Shared by the header and cells, including responsive visibility and width. */
	className?: string;
	align?: 'left' | 'right' | 'center';
}

export interface DataTableProps<T> {
	label: string;
	items: readonly T[];
	columns: readonly DataTableColumn<T>[];
	getRowKey: (item: T) => Key;
	rowClassName?: (item: T) => string | undefined;
	rowTestId?: string;
	stickyHeader?: boolean;
}

const ALIGNMENT = { left: 'text-left', right: 'text-right', center: 'text-center' };

export function DataTable<T>({
	label,
	items,
	columns,
	getRowKey,
	rowClassName,
	rowTestId,
	stickyHeader = true,
}: DataTableProps<T>) {
	return (
		// Clip the outer corners without creating a scroll container for the sticky header.
		<div className="overflow-clip rounded-xl border bg-card shadow-xs">
			<table
				aria-label={label}
				className="w-full table-fixed border-separate border-spacing-0 text-sm"
			>
				<thead>
					<tr>
						{columns.map((column) => (
							<th
								key={column.id}
								scope="col"
								className={cn(
									'border-b bg-muted px-4 py-3 text-xs font-medium text-muted-foreground max-sm:px-3',
									stickyHeader && 'sticky top-0 z-10',
									ALIGNMENT[column.align ?? 'left'],
									column.className,
								)}
							>
								{column.header}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{items.map((item) => (
						<tr
							key={getRowKey(item)}
							data-testid={rowTestId}
							className={cn(
								'group hover:bg-accent/60 focus-within:bg-accent/60',
								rowClassName?.(item),
							)}
						>
							{columns.map((column) => (
								<td
									key={column.id}
									className={cn(
										'border-b px-4 py-3 align-middle group-last:border-b-0 max-sm:px-3',
										ALIGNMENT[column.align ?? 'left'],
										column.className,
									)}
								>
									{column.cell(item)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
