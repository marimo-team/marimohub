import { useState } from 'react';
import { folderImportFileLimit, WORKSPACE_LIMITS } from '@marimo-hub/core/remote-workspace';
import { TextField } from '@/components/ui';
import { formatBytes } from '@/lib/formatBytes';
import type { FolderFile } from './folderImport';

import { ImportPagination, IMPORT_PAGE_SIZE } from './ImportPagination';
const exclusionLabels = {
	generated: 'Generated files or Git metadata',
	sensitive: 'May contain credentials',
};

export function ImportFileReview({
	files,
	onChange,
}: {
	files: FolderFile[];
	onChange: (path: string, patch: Partial<FolderFile>) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [search, setSearch] = useState('');
	const [filter, setFilter] = useState('all');
	const [page, setPage] = useState(0);
	const included = files.filter((file) => file.included);
	const fileLimit = folderImportFileLimit(included);
	const matches = expanded
		? files.filter(
				(file) =>
					file.path.toLowerCase().includes(search.toLowerCase()) &&
					(filter === 'all' || file.included === (filter === 'included')),
			)
		: [];
	const pages = Math.max(1, Math.ceil(matches.length / IMPORT_PAGE_SIZE));
	const currentPage = Math.min(page, pages - 1);

	return (
		<details
			className="rounded-lg border p-3"
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary className="cursor-pointer text-sm font-medium">
				Included files: {included.length} ·{' '}
				{formatBytes(included.reduce((sum, file) => sum + file.file.size, 0))} ·{' '}
				{files.length - included.length} excluded
			</summary>
			{expanded && (
				<>
					<div className="mt-3 flex flex-wrap gap-2">
						<TextField
							className="min-w-40 flex-1"
							aria-label="Filter included and excluded files"
							placeholder="Filter file paths…"
							value={search}
							onChange={(value) => {
								setSearch(value);
								setPage(0);
							}}
						/>
						<select
							aria-label="Show files"
							className="rounded-md border bg-background px-2 text-sm"
							value={filter}
							onChange={(event) => {
								setFilter(event.target.value);
								setPage(0);
							}}
						>
							<option value="all">All files</option>
							<option value="included">Included</option>
							<option value="excluded">Excluded</option>
						</select>
					</div>
					<div className="mt-3 max-h-60 divide-y overflow-auto">
						{matches
							.slice(currentPage * IMPORT_PAGE_SIZE, (currentPage + 1) * IMPORT_PAGE_SIZE)
							.map((file) => (
								<label key={file.path} className="flex items-start gap-2 py-2 text-xs">
									<input
										className="mt-0.5 size-4 shrink-0 accent-primary"
										type="checkbox"
										aria-label={`Include ${file.path}`}
										checked={file.included}
										disabled={file.selected || file.exclusion === 'generated'}
										onChange={(event) => onChange(file.path, { included: event.target.checked })}
									/>
									<span className="min-w-0 flex-1">
										<span className="block break-all font-mono">{file.path}</span>
										<span className="text-muted-foreground">
											{file.error ||
												(file.selected
													? 'Selected notebook'
													: !file.included
														? file.exclusion
															? exclusionLabels[file.exclusion]
															: 'Excluded by you'
														: '')}
										</span>
									</span>
									<span className="shrink-0 text-muted-foreground">
										{formatBytes(file.file.size)}
									</span>
								</label>
							))}
						{matches.length === 0 && (
							<p className="py-4 text-center text-sm text-muted-foreground">
								No files match these filters.
							</p>
						)}
					</div>
					<ImportPagination
						count={matches.length}
						page={currentPage}
						onPageChange={setPage}
						label="files"
					/>
					<p className="mt-3 text-xs text-muted-foreground">
						Caches and Git metadata stay excluded. A filename filter excludes common credentials,
						but cannot detect every secret. Review and exclude other sensitive files.
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						Limits: {fileLimit.toLocaleString('en-US')} included files,{' '}
						{formatBytes(WORKSPACE_LIMITS.maxFileBytes)} per file,{' '}
						{formatBytes(WORKSPACE_LIMITS.maxTotalBytes)} total.
					</p>
					{fileLimit < WORKSPACE_LIMITS.maxFiles && (
						<p className="mt-1 text-xs text-muted-foreground">
							An empty pyproject.toml will be added at the root, using one of the{' '}
							{WORKSPACE_LIMITS.maxFiles.toLocaleString('en-US')} workspace file slots.
						</p>
					)}
				</>
			)}
		</details>
	);
}
