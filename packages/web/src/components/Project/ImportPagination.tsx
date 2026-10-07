import { Button } from '@/components/ui';

export const IMPORT_PAGE_SIZE = 100;

export function ImportPagination({
	count,
	page,
	onPageChange,
	label,
}: {
	count: number;
	page: number;
	onPageChange: (page: number) => void;
	label: 'notebooks' | 'files';
}) {
	const pages = Math.ceil(count / IMPORT_PAGE_SIZE);
	if (pages <= 1) return null;
	return (
		<div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
			<span>
				{count} {label} · Page {page + 1} of {pages}
			</span>
			<div className="flex gap-2">
				<Button size="sm" isDisabled={page === 0} onPress={() => onPageChange(page - 1)}>
					Previous {label}
				</Button>
				<Button size="sm" isDisabled={page + 1 === pages} onPress={() => onPageChange(page + 1)}>
					Next {label}
				</Button>
			</div>
		</div>
	);
}
