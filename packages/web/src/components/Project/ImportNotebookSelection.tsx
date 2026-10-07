import type { Dispatch, SetStateAction } from 'react';
import { Button, TextField } from '@/components/ui';
import { ImportPagination, IMPORT_PAGE_SIZE } from './ImportPagination';
import type { FolderFile } from './folderImport';

export function ImportNotebookSelection({
	files,
	onFilesChange,
	onFileChange,
	projectName,
	search,
	onSearchChange,
	page,
	onPageChange,
}: {
	files: FolderFile[];
	onFilesChange: Dispatch<SetStateAction<FolderFile[]>>;
	onFileChange: (path: string, patch: Partial<FolderFile>) => void;
	projectName: string;
	search: string;
	onSearchChange: (search: string) => void;
	page: number;
	onPageChange: (page: number) => void;
}) {
	const selected = files.filter((file) => file.selected);
	const candidates = files.filter(
		(file) => file.candidate && file.path.toLowerCase().includes(search.toLowerCase()),
	);
	const currentPage = Math.min(
		page,
		Math.max(0, Math.ceil(candidates.length / IMPORT_PAGE_SIZE) - 1),
	);
	const visibleCandidates = candidates.slice(
		currentPage * IMPORT_PAGE_SIZE,
		(currentPage + 1) * IMPORT_PAGE_SIZE,
	);

	return (
		<>
			<TextField
				aria-label="Search notebook paths"
				placeholder="Search notebook paths…"
				value={search}
				onChange={(value) => {
					onSearchChange(value);
					onPageChange(0);
				}}
			/>
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<span>
					{selected.length} selected · {candidates.length} matching notebooks
				</span>
				<div className="flex gap-2">
					<Button
						size="sm"
						variant="ghost"
						isDisabled={!candidates.some((file) => !file.selected && !file.error)}
						onPress={() => {
							const paths = new Set(candidates.flatMap((file) => (file.error ? [] : [file.path])));
							onFilesChange((current) =>
								current.map((file) =>
									paths.has(file.path) ? { ...file, selected: true, included: true } : file,
								),
							);
						}}
					>
						Select matching
					</Button>
					<Button
						size="sm"
						variant="ghost"
						isDisabled={selected.length === 0}
						onPress={() =>
							onFilesChange((current) => current.map((file) => ({ ...file, selected: false })))
						}
					>
						Clear selection
					</Button>
				</div>
			</div>
			<div className="max-h-72 overflow-auto rounded-lg border">
				<table className="w-full table-fixed text-left text-sm">
					<thead className="sticky top-0 bg-muted">
						<tr>
							<th className="w-12 p-3">
								<span className="sr-only">Import</span>
							</th>
							<th className="p-3">Notebook path</th>
							<th className="p-3">Name in {projectName}</th>
						</tr>
					</thead>
					<tbody>
						{visibleCandidates.map((file) => (
							<tr key={file.path} className="border-t">
								<td className="p-3">
									<input
										type="checkbox"
										className="size-4 accent-primary"
										aria-label={`Import ${file.path}`}
										checked={file.selected}
										disabled={!!file.error}
										onChange={(event) =>
											onFileChange(file.path, {
												selected: event.target.checked,
												...(event.target.checked ? { included: true } : {}),
											})
										}
									/>
								</td>
								<td className="break-all p-3 font-mono text-xs">{file.path}</td>
								<td className="p-3">
									<TextField
										aria-label={`Name for ${file.path}`}
										value={file.title}
										maxLength={200}
										isDisabled={!file.selected}
										onChange={(title) => onFileChange(file.path, { title })}
									/>
								</td>
							</tr>
						))}
						{candidates.length === 0 && (
							<tr>
								<td colSpan={3} className="p-6 text-center text-muted-foreground">
									{search
										? 'No notebook paths match your search.'
										: 'No supported notebooks found. Choose a folder containing .py, .md, .markdown, or .qmd files.'}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
			<ImportPagination
				count={candidates.length}
				page={currentPage}
				onPageChange={onPageChange}
				label="notebooks"
			/>
			<p className="text-xs text-muted-foreground">
				Likely marimo notebooks are selected. Unchecking a notebook keeps its file available as a
				supporting file.
			</p>
		</>
	);
}
