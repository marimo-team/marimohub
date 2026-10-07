import { Check, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatAbsolute } from '@/lib/time';
import { cn } from '@/lib/utils';
import { importStateLabels, isImportRetryable } from './useNotebookImport';
import type { ImportRow } from './useNotebookImport';
import { ImportPagination, IMPORT_PAGE_SIZE } from './ImportPagination';

export function ImportResults({
	rows,
	projectId,
	phase,
	stopping,
	busy,
	expiresAt,
	page,
	onPageChange,
}: {
	rows: ImportRow[];
	projectId: string;
	phase: 'idle' | 'uploading' | 'importing';
	stopping: boolean;
	busy: boolean;
	expiresAt?: string;
	page: number;
	onPageChange: (page: number) => void;
}) {
	const completeCount = rows.filter((row) => row.state === 'imported').length;
	const visibleRows = rows.slice(page * IMPORT_PAGE_SIZE, (page + 1) * IMPORT_PAGE_SIZE);
	return (
		<>
			<p className="text-sm" aria-live="polite">
				{completeCount} of {rows.length} imported
				{phase === 'uploading' ? ' · Preparing and uploading folder…' : ''}
				{stopping && busy ? ' · Stopping after the current request…' : ''}
			</p>
			<div className="divide-y rounded-lg border">
				{visibleRows.map((row) => (
					<div key={row.path} className="flex items-start gap-3 p-3">
						{row.state === 'imported' ? (
							<Check className="mt-1 size-4 text-emerald-600" />
						) : row.state === 'importing' ? (
							<LoaderCircle className="mt-1 size-4 animate-spin" />
						) : (
							<span className="mt-1 size-4" />
						)}
						<div className="min-w-0 flex-1">
							<p className="text-sm font-medium">{row.title}</p>
							<p className="break-all font-mono text-xs text-muted-foreground">{row.path}</p>
							{row.message && (
								<p
									className={cn(
										'mt-1 text-xs',
										row.messageTone === 'neutral' ? 'text-muted-foreground' : 'text-destructive',
									)}
								>
									{row.message}
								</p>
							)}
						</div>
						<div className="shrink-0 text-xs">
							{row.notebookId ? (
								<Link
									className="text-primary underline"
									target="_blank"
									rel="noopener"
									aria-label={`View ${row.path} (opens in new tab)`}
									to={`/projects/${projectId}/notebooks/${row.notebookId}`}
								>
									View notebook
								</Link>
							) : (
								importStateLabels[row.state]
							)}
						</div>
					</div>
				))}
			</div>
			<ImportPagination
				count={rows.length}
				page={page}
				onPageChange={onPageChange}
				label="notebooks"
			/>
			<p className="text-xs text-muted-foreground">
				{completeCount === rows.length
					? 'Your notebooks are ready. Each has its own copy of the included files.'
					: !rows.some(isImportRetryable)
						? 'Some notebooks could not be imported. Review the errors before starting another import.'
						: `Keep this page open until the import finishes. Stop lets the current request finish and keeps imported notebooks.${expiresAt ? ` You can retry this upload until ${formatAbsolute(expiresAt)}.` : ''}`}
			</p>
		</>
	);
}
